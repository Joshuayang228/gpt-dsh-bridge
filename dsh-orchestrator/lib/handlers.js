/**
 * The eight capabilities, implemented against DSH's official services only.
 *
 * INVARIANTS this module is written to uphold, each one covered by a test:
 *
 *  1. Nothing here reads or writes a session persistence file. The invariant
 *     test greps this directory for the log filename, its compression suffix,
 *     the projection cache, the workspace store, and the versioned log
 *     filename — all five must be absent.
 *  2. `sessionController.create` is called from exactly one place —
 *     {@link createSession}. Every other handler takes an explicit session id
 *     and never creates. A busy session therefore can never be "worked around"
 *     by silently opening a second one.
 *  3. Read paths never resume an agent. Status reads go through
 *     `sessionController.list`, waits go through `sessionController.follow`;
 *     neither claims a write handle, so querying state cannot wake a cold
 *     session or take a lock away from anybody.
 *  4. `attach` goes through `WorkspaceEntity.attachSession` — the official
 *     ownership write — and never through the filesystem. Its cwd gate is
 *     DSH's, and a rejection is reported as SESSION_CWD_MISMATCH with both
 *     paths so the operator can see why.
 *
 * @module dsh-orchestrator/handlers
 */

import { randomUUID } from 'node:crypto';

import { CODES, classifyDsh, fail, optionalString, requireString } from './errors.js';
import { readSandboxState, sandboxOfRow, setSandboxState } from './sandbox.js';

/** Title prefix for every session this surface creates. */
export const TITLE_PREFIX = 'GPT-';

/** DSH's own title cap, from `dsh-base/cordis.patch.yml` (`maxTitleBytes: 80`). */
export const MAX_TITLE_BYTES = 80;

/** Cap on the assistant text returned by status, so one frame stays bounded. */
const MAX_LAST_TURN_TEXT_CHARS = 20_000;

/** Terminal control characters, zero-width and bidi controls. */
const STRIPPED_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Collapse and clean a workstream name.
 * @param raw - the caller's workstream.
 * @returns the normalized name.
 * @throws {OrchestratorError} TITLE_INVALID when nothing visible remains.
 */
export function normalizeWorkstream(raw) {
  const cleaned = raw.replace(/\s+/gu, ' ').replace(STRIPPED_CHARACTERS, '').trim();
  if (cleaned.length === 0) {
    throw fail(CODES.TITLE_INVALID, 'workstream is empty after normalization');
  }
  return cleaned;
}

/**
 * Build the canonical `GPT-<workstream>` title.
 *
 * The byte cap is enforced here rather than left to DSH, and the input is
 * rejected rather than truncated: the title is the routing key, so silently
 * shortening it could make two different workstreams collide.
 * @param workstream - a normalized workstream name.
 * @returns the title.
 * @throws {OrchestratorError} TITLE_INVALID when the title exceeds the cap.
 */
export function titleForWorkstream(workstream) {
  // Idempotent: a caller that already wrote the prefix does not get `GPT-GPT-`.
  let body = workstream.trim();
  while (body.startsWith(TITLE_PREFIX)) body = body.slice(TITLE_PREFIX.length);
  const normalized = normalizeWorkstream(body);
  const title = `${TITLE_PREFIX}${normalized}`;
  const bytes = Buffer.byteLength(title, 'utf8');
  if (bytes > MAX_TITLE_BYTES) {
    const prefixBytes = Buffer.byteLength(TITLE_PREFIX, 'utf8');
    throw fail(
      CODES.TITLE_INVALID,
      `title "${title}" is ${bytes} UTF-8 bytes, over DSH's ${MAX_TITLE_BYTES}-byte limit`,
      {
        title,
        bytes,
        maxBytes: MAX_TITLE_BYTES,
        workstreamBytes: Buffer.byteLength(normalized, 'utf8'),
        maxWorkstreamBytes: MAX_TITLE_BYTES - prefixBytes,
      },
    );
  }
  return title;
}

/**
 * Join the text blocks of one session content array.
 * @param content - a `content` array, or a bare string.
 * @returns the concatenated text.
 */
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

/**
 * Project one `turn/end` reason into a small stable object.
 * @param reason - the event's `data.reason`.
 * @returns the projection, or `null`.
 */
export function turnReason(reason) {
  if (reason === null || typeof reason !== 'object') return null;
  const out = { kind: typeof reason.kind === 'string' ? reason.kind : null };
  if (reason.kind === 'error' && reason.error !== null && typeof reason.error === 'object') {
    if (typeof reason.error.code === 'string') out.code = reason.error.code;
    if (typeof reason.error.message === 'string') out.message = reason.error.message.slice(0, 600);
    if (typeof reason.error.status === 'number') out.status = reason.error.status;
  }
  if (reason.kind === 'aborted') out.cause = reason.reason?.kind ?? reason.cause ?? null;
  return out;
}

/**
 * Extract the last turn from a follow snapshot's records, or from streamed
 * events. Works on both because both carry the same event shape.
 * @param records - snapshot `records`, or a single `{event}` wrapper.
 * @returns `{seq, reason, text}` with `null`s where nothing was observed.
 */
export function foldLastTurn(records) {
  let seq = null;
  let reason = null;
  let text = null;
  const list = Array.isArray(records) ? records : [];
  for (const record of list) {
    const event = record?.type === 'event' ? record.event : record;
    if (event === null || typeof event !== 'object') continue;
    const eventSeq = typeof event.seq === 'number' ? event.seq : null;
    if (event.type === 'assistant/message') {
      const candidate = textOf(event.data?.message?.content);
      if (candidate.length > 0) {
        text = candidate;
        seq = eventSeq;
      }
    } else if (event.type === 'turn/end') {
      reason = turnReason(event.data?.reason);
      if (seq === null) seq = eventSeq;
    }
  }
  return { seq, reason, text };
}

/**
 * Bound the assistant text carried in one response.
 * @param folded - the folded last turn.
 * @returns the folded turn plus truncation facts.
 */
function boundText(folded) {
  const out = { ...folded };
  if (typeof out.text === 'string' && out.text.length > MAX_LAST_TURN_TEXT_CHARS) {
    out.textBytes = Buffer.byteLength(out.text, 'utf8');
    out.text = out.text.slice(0, MAX_LAST_TURN_TEXT_CHARS);
    out.textTruncated = true;
  } else if (typeof out.text === 'string') {
    out.textBytes = Buffer.byteLength(out.text, 'utf8');
    out.textTruncated = false;
  }
  return out;
}

/**
 * Build a timeout signal whose timer never keeps the process alive.
 * @param ms - the budget.
 * @returns `{signal, cancel}`; always call `cancel()`.
 */
function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      controller.abort();
    },
  };
}

/**
 * One `sessionController.list` read of every visible session.
 * @param services - the resolved services.
 * @returns the summary rows.
 * @throws {OrchestratorError} on a classified upstream failure.
 */
async function readSessionSummaries(services) {
  const timeout = withTimeout(services.requestTimeoutMs);
  try {
    const value = await services.sessionController.list({}, timeout.signal);
    const items = value?.items;
    return Array.isArray(items) ? items : [];
  } catch (error) {
    throw classifyDsh(error, { operation: 'session.list' });
  } finally {
    timeout.cancel();
  }
}

/** Read the archived set synchronously off the registry (no upstream call). */
function archivedSet(services) {
  try {
    const ids = services.workspaceRegistry.archivedSessionIds;
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
}

/**
 * Project one `SessionSummary` into the row this surface publishes.
 *
 * The row carries the standing `sandbox/mode` override and the effective
 * sandbox policy derived from it. Both are free: `sessionController.list()`
 * already returns every projection value, so exposing the policy here costs no
 * additional upstream call and can therefore ride along on every row.
 *
 * @param summary - the upstream row.
 * @param archived - the archived id set.
 * @param services - the resolved services, for the deployment sandbox default.
 * @returns the projected row.
 */
function projectSession(summary, archived, services) {
  const values = summary?.projections?.values ?? {};
  const title = values.title ?? values.sessionTitle;
  const sessionId = typeof summary?.sessionId === 'string' ? summary.sessionId : summary?.id;
  const row = {
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    title: typeof title === 'string' && title.length > 0 ? title : null,
    cwd: typeof summary?.cwd === 'string' ? summary.cwd : null,
    origin: typeof summary?.origin === 'string' ? summary.origin : null,
    parentSessionId: typeof summary?.parentSessionId === 'string' ? summary.parentSessionId : null,
    running: summary?.running === true,
    blank: summary?.blank === true,
    agentAvailable: summary?.agentAvailable === true,
    updatedAt: typeof summary?.updatedAt === 'number' ? summary.updatedAt : null,
    archived: archived.has(sessionId),
    // The logged override, present ONLY when the summary actually carried it.
    // `null` and "the summary omitted the unit" are different facts: the first
    // proves the session has no override, the second only proves this face
    // cannot see one. `sandboxOfRow` needs that distinction to avoid inventing a
    // source.
    ...(typeof values.sandboxMode === 'string' ? { sandboxModeOverride: values.sandboxMode } : {}),
  };
  return { ...row, sandbox: sandboxOfRow(row, services) };
}

/**
 * Project one Workspace into the row this surface publishes.
 *
 * Two producer shapes feed this function and they spell the identity
 * differently, which is worth stating because getting it wrong is silent:
 * `workspaceRegistry.list()` yields registry entities carrying `id`, while
 * `workspaceController.create()` yields a `WorkspaceView` carrying
 * `workspaceId`. Both are official; the projection accepts either.
 * @param workspace - a registry entity or a `WorkspaceView`.
 * @returns the projected row.
 */
function projectWorkspace(workspace) {
  const workspaceId = workspace?.workspaceId ?? workspace?.id;
  return {
    workspaceId: typeof workspaceId === 'string' ? workspaceId : null,
    path: typeof workspace?.path === 'string' ? workspace.path : null,
    title: typeof workspace?.title === 'string' ? workspace.title : null,
    sessionIds: Array.isArray(workspace?.sessionIds) ? [...workspace.sessionIds] : [],
    createdAt: typeof workspace?.createdAt === 'string' ? workspace.createdAt : null,
    updatedAt: typeof workspace?.updatedAt === 'string' ? workspace.updatedAt : null,
  };
}

/** `workspace.list` — the registered Workspaces and their accounting. */
export function listWorkspaces(services) {
  const workspaces = services.workspaceRegistry.list();
  const items = (Array.isArray(workspaces) ? workspaces : []).map(projectWorkspace);
  return { items, archivedSessionIds: [...archivedSet(services)] };
}

/**
 * `workspace.ensure` — create or reuse the Workspace over one directory.
 * DSH's `create` is already idempotent for an existing directory, so this is
 * safe to call before every routing decision.
 * @param services - the resolved services.
 * @param body - the decoded request body.
 * @returns `{workspace, created}`.
 */
export async function ensureWorkspace(services, body) {
  const path = requireString(body, 'path');
  const timeout = withTimeout(services.requestTimeoutMs);
  try {
    const value = await services.workspaceController.create({ path }, timeout.signal);
    if (value === undefined || value.workspace === undefined) {
      throw fail(CODES.DSH_ERROR, 'workspace.create returned no workspace');
    }
    return { workspace: projectWorkspace(value.workspace), created: value.created === true };
  } catch (error) {
    throw classifyDsh(error, { operation: 'workspace.ensure', path });
  } finally {
    timeout.cancel();
  }
}

/**
 * `session.list` — every visible session, with the archived flag applied.
 * @param services - the resolved services.
 * @param query - the request query string.
 * @returns `{items, total, archivedHidden}`.
 */
export async function listSessions(services, query) {
  const includeArchived = query.get('includeArchived') === 'true';
  const summaries = await readSessionSummaries(services);
  const archived = archivedSet(services);
  const rows = summaries.map((summary) => projectSession(summary, archived, services));
  const kept = includeArchived ? rows : rows.filter((row) => row.archived !== true);
  return { items: kept, total: kept.length, archivedHidden: rows.length - kept.length };
}

/**
 * `session.create` — create a session, name it `GPT-<workstream>`, and let DSH
 * attach it when a Workspace was named.
 *
 * This is the only function in this plugin that creates a session.
 * @param services - the resolved services.
 * @param body - the decoded request body.
 * @returns the created session's identity and naming outcome.
 */
export async function createSession(services, body) {
  const workstream = normalizeWorkstream(requireString(body, 'workstream'));
  const title = titleForWorkstream(workstream);
  const workspaceId = optionalString(body, 'workspaceId');
  const cwd = optionalString(body, 'cwd');
  const agentPreset = optionalString(body, 'agentPreset');

  if (workspaceId !== undefined && cwd !== undefined) {
    throw fail(CODES.BAD_REQUEST, 'pass workspaceId or cwd, not both; DSH rejects a session.create carrying both');
  }
  if (workspaceId === undefined && cwd === undefined) {
    throw fail(CODES.BAD_REQUEST, 'workspaceId or cwd is required; this surface never creates a session in an implicit directory');
  }

  const timeout = withTimeout(services.requestTimeoutMs);
  let created;
  try {
    created = await services.sessionController.create(
      {
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(cwd === undefined ? {} : { cwd }),
        ...(agentPreset === undefined ? {} : { agentPreset }),
      },
      timeout.signal,
    );
  } catch (error) {
    throw classifyDsh(error, { operation: 'session.create', workspaceId: workspaceId ?? null, cwd: cwd ?? null });
  } finally {
    timeout.cancel();
  }

  const sessionId = created?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw fail(CODES.DSH_ERROR, 'session.create returned no sessionId');
  }

  // DSH has no title at creation time, so the supported sequence is
  // create-then-rename. A rename failure must never orphan the session
  // silently: the id is reported alongside the partial state.
  try {
    const renamed = await services.sessionController.rename({ sessionId, title });
    return {
      sessionId,
      title: typeof renamed?.title === 'string' ? renamed.title : title,
      workspaceId: workspaceId ?? null,
      cwd: cwd ?? null,
      agentPreset: agentPreset ?? null,
      renamed: true,
    };
  } catch (error) {
    const mapped = classifyDsh(error, { operation: 'session.rename', sessionId });
    throw fail(
      mapped.code,
      `session "${sessionId}" was created but could not be named "${title}": ${mapped.message}`,
      {
        sessionId,
        intendedTitle: title,
        workspaceId: workspaceId ?? null,
        partial: { created: true, renamed: false, attached: workspaceId !== undefined },
        dshCode: mapped.details?.dshCode ?? null,
      },
    );
  }
}

/**
 * `session.attach` — account an existing session to an existing Workspace.
 *
 * The official write is `WorkspaceEntity.attachSession`, which validates that
 * the session's recorded canonical cwd equals the Workspace path. That gate is
 * DSH's; this function only reports its verdict.
 * @param services - the resolved services.
 * @param sessionId - the session to account.
 * @param body - the decoded request body.
 * @returns the attach outcome and the resulting accounting.
 */
export async function attachSession(services, sessionId, body) {
  const workspaceId = requireString(body, 'workspaceId');
  const registry = services.workspaceRegistry;
  const workspace = registry.get(workspaceId);
  if (workspace === undefined) {
    throw fail(CODES.WORKSPACE_NOT_FOUND, `workspace "${workspaceId}" is not registered`, { workspaceId });
  }
  if (typeof workspace.attachSession !== 'function') {
    throw fail(CODES.WORKSPACE_ATTACH_UNSUPPORTED, 'this Host\'s Workspace entity exposes no attachSession', {
      workspaceId,
    });
  }

  try {
    await workspace.attachSession(sessionId);
  } catch (error) {
    throw classifyDsh(error, {
      operation: 'workspace.attachSession',
      sessionId,
      workspaceId,
      workspacePath: workspace.path,
    });
  }

  const after = registry.get(workspaceId);
  const sessionIds = Array.isArray(after?.sessionIds) ? [...after.sessionIds] : [];
  return {
    ok: true,
    sessionId,
    workspaceId,
    workspacePath: workspace.path,
    attached: sessionIds.includes(sessionId),
    sessionIds,
  };
}

/**
 * `session.rename` — set a title, or derive one from a workstream.
 * @param services - the resolved services.
 * @param sessionId - the session to rename.
 * @param body - the decoded request body.
 * @returns `{sessionId, title, seq}`.
 */
export async function renameSession(services, sessionId, body) {
  const explicit = optionalString(body, 'title');
  const workstream = optionalString(body, 'workstream');
  const title = explicit ?? (workstream === undefined ? undefined : titleForWorkstream(normalizeWorkstream(workstream)));
  if (title === undefined) {
    throw fail(CODES.BAD_REQUEST, 'title or workstream is required');
  }
  try {
    const value = await services.sessionController.rename({ sessionId, title });
    return {
      sessionId,
      title: typeof value?.title === 'string' ? value.title : title,
      seq: typeof value?.seq === 'number' ? value.seq : null,
    };
  } catch (error) {
    throw classifyDsh(error, { operation: 'session.rename', sessionId });
  }
}

/**
 * `session.prompt` — admit one text prompt.
 *
 * `mode` defaults to `queue`; `steer` is accepted only when named explicitly,
 * so an orchestrator cannot interrupt a running turn by accident.
 * @param services - the resolved services.
 * @param sessionId - the target session.
 * @param body - the decoded request body.
 * @returns `{sessionId, requestId, mode, accepted}`.
 */
export async function promptSession(services, sessionId, body) {
  const text = requireString(body, 'text');

  if (body !== null && typeof body === 'object' && body.images !== undefined) {
    throw fail(CODES.BAD_REQUEST, 'this surface is text-only; the images field is not supported');
  }

  const rawMode = optionalString(body, 'mode');
  let mode = 'queue';
  if (rawMode !== undefined) {
    if (rawMode !== 'queue' && rawMode !== 'steer') {
      throw fail(CODES.BAD_REQUEST, `mode must be "queue" or "steer"; got "${rawMode}"`, { mode: rawMode });
    }
    mode = rawMode;
  }

  const requestId = optionalString(body, 'requestId') ?? randomUUID();
  const timeout = withTimeout(services.requestTimeoutMs);
  try {
    // `signal` is a REQUIRED second parameter on the host method
    // (`prompt(request, signal)`), and the implementation dereferences it
    // without optional chaining — omitting it throws inside DSH rather than
    // being ignored, which is exactly how this was found.
    await services.sessionController.prompt(
      { requestId, sessionId, mode, content: [{ type: 'text', text }] },
      timeout.signal,
    );
    return { sessionId, requestId, mode, accepted: true };
  } catch (error) {
    throw classifyDsh(error, { operation: 'session.prompt', sessionId, requestId, mode });
  } finally {
    timeout.cancel();
  }
}

/**
 * `session.status` — read the current state, and optionally wait for idle.
 *
 * Both halves are read-only: the read uses `list`, the wait uses `follow`.
 * Neither resolves an agent, so this endpoint can never resume a cold session
 * and can never take a write handle.
 * @param services - the resolved services.
 * @param sessionId - the target session.
 * @param query - the request query string.
 * @returns the status projection.
 */
export async function sessionStatus(services, sessionId, query) {
  const wait = query.get('wait');
  if (wait !== null && wait !== 'idle') {
    throw fail(CODES.BAD_REQUEST, 'wait, when present, must be "idle"', { wait });
  }

  const summaries = await readSessionSummaries(services);
  const archived = archivedSet(services);
  const found = summaries.find((summary) => (summary?.sessionId ?? summary?.id) === sessionId);
  if (found === undefined) {
    throw fail(CODES.SESSION_NOT_FOUND, `session "${sessionId}" is not visible to this Host`, { sessionId });
  }
  const base = projectSession(found, archived, services);

  // A live session's policy is authoritative and costs no upstream call: the
  // policy service resolves it off the handle it already holds. This is what
  // makes `status` agree with the dedicated endpoint instead of repeating the
  // row's "not observable from here" answer.
  // Guard on `!= null`, not `!== undefined`: `requirePolicy` refuses both, and a
  // null policy would otherwise turn a status read into a 501.
  if (services.sandboxPolicy != null && typeof services.sessions?.get === 'function') {
    if (services.sessions.get(sessionId) !== undefined) {
      base.sandbox = await readSandboxState(services, sessionId, { row: base });
    }
  }

  if (wait === null) {
    return { ...base, waitOutcome: 'not-requested', lastTurn: null };
  }

  // A caller may ask for a longer wait than the default, up to the configured
  // ceiling; anything outside the range is clamped rather than refused, so a
  // slightly greedy orchestrator still gets an answer.
  const requestedTimeout = query.get('timeoutMs');
  let budget = services.waitTimeoutMs;
  if (requestedTimeout !== null) {
    const parsed = Number(requestedTimeout);
    if (!Number.isFinite(parsed)) {
      throw fail(CODES.BAD_REQUEST, 'timeoutMs must be a number', { timeoutMs: requestedTimeout });
    }
    budget = Math.min(Math.max(Math.trunc(parsed), 1_000), services.waitTimeoutMaxMs);
  }
  const timeout = withTimeout(budget);
  // The outcome label reports what the caller found, not only what the stream
  // did: a session that was already idle had nothing to wait for.
  const wasRunning = base.running === true;
  let cursor = null;
  let folded = { seq: null, reason: null, text: null };
  try {
    const stream = services.sessionController.follow({ address: { kind: 'session', sessionId } }, timeout.signal);
    for await (const frame of stream) {
      if (frame?.type === 'snapshot') {
        cursor = typeof frame.cursor === 'number' ? frame.cursor : null;
        folded = foldLastTurn(frame.records);
        // Already idle before we subscribed: the snapshot alone answers the
        // question, so release the stream now rather than waiting for a
        // turn/end that is never coming.
        if (!wasRunning) {
          return { ...base, waitOutcome: 'already-idle', lastTurn: boundText(folded) };
        }
        // Running when we subscribed, so re-read rather than guess: the turn
        // may have completed between the pre-read and this subscription, in
        // which case no further turn/end will ever arrive.
        const again = await readSessionSummaries(services);
        const now = again.find((summary) => (summary?.sessionId ?? summary?.id) === sessionId);
        if (now === undefined) {
          throw fail(CODES.SESSION_NOT_FOUND, `session "${sessionId}" disappeared while waiting`, { sessionId });
        }
        if (now.running !== true) {
          return { ...projectSession(now, archived, services), waitOutcome: 'idle', lastTurn: boundText(folded) };
        }
        continue;
      }
      if (frame?.type !== 'event') continue;

      const event = frame.event;
      const eventSeq = typeof event?.seq === 'number' ? event.seq : null;
      if (event?.type === 'assistant/message') {
        const candidate = textOf(event.data?.message?.content);
        if (candidate.length > 0) {
          folded.text = candidate;
          folded.seq = eventSeq;
        }
        continue;
      }
      if (event?.type === 'turn/end') {
        folded.reason = turnReason(event.data?.reason);
        if (folded.seq === null) folded.seq = eventSeq;
        if (cursor === null || (eventSeq !== null && eventSeq > cursor)) {
          const settled = await readSessionSummaries(services);
          const now = settled.find((summary) => (summary?.sessionId ?? summary?.id) === sessionId);
          return {
            ...(now === undefined ? base : projectSession(now, archived, services)),
            waitOutcome: 'idle',
            lastTurn: boundText(folded),
          };
        }
      }
    }
    return { ...base, waitOutcome: 'stream-ended', lastTurn: boundText(folded) };
  } catch (error) {
    if (timeout.signal.aborted) {
      return { ...base, waitOutcome: 'timeout', lastTurn: boundText(folded) };
    }
    throw classifyDsh(error, { operation: 'session.status', sessionId });
  } finally {
    timeout.cancel();
  }
}

/**
 * Find one session's projected essentials, or refuse.
 * @param services - the resolved services.
 * @param sessionId - the target session.
 * @returns `{title, cwd}`.
 */
async function findSessionRow(services, sessionId) {
  const summaries = await readSessionSummaries(services);
  const found = summaries.find((summary) => (summary?.sessionId ?? summary?.id) === sessionId);
  if (found === undefined) {
    throw fail(CODES.SESSION_NOT_FOUND, `session "${sessionId}" is not visible to this Host`, { sessionId });
  }
  const values = found?.projections?.values ?? {};
  const title = values.title ?? values.sessionTitle;
  return {
    title: typeof title === 'string' && title.length > 0 ? title : null,
    cwd: typeof found?.cwd === 'string' ? found.cwd : null,
  };
}

/**
 * `session.sandbox` — read one session's effective file policy.
 *
 * Read-only in every path: it never attaches, never resumes an Agent and never
 * claims a write handle, so asking about permissions cannot change them. The
 * standing override comes from `sessionController.projections`, which works on a
 * cold session; `writable` reports whether a switch would be possible right now.
 *
 * @param services - the resolved services.
 * @param sessionId - the target session.
 * @returns `{sessionId, title, cwd, sandbox}`.
 */
export async function sandboxStatus(services, sessionId) {
  const found = await findSessionRow(services, sessionId);
  const timeout = withTimeout(services.requestTimeoutMs);
  try {
    const sandbox = await readSandboxState(services, sessionId, {
      signal: timeout.signal,
      row: { cwd: found.cwd },
    });
    return { sessionId, title: found.title, cwd: found.cwd, sandbox };
  } catch (error) {
    throw classifyDsh(error, { operation: 'session.sandbox', sessionId });
  } finally {
    timeout.cancel();
  }
}

/**
 * `session.sandbox.set` — switch one session's mode, explicitly.
 *
 * The only entry point in this surface that can change a mode. It is never
 * reached from a failed prompt, a denial or a path rejection: those surface as
 * their own codes and stop there, so `danger-full-access` happens only when a
 * caller named it.
 *
 * @param services - the resolved services.
 * @param sessionId - the target session.
 * @param body - `{mode}`.
 * @returns the before/after summary with read-back verification.
 */
export async function setSandbox(services, sessionId, body) {
  // Deliberately not `requireString`: the mode vocabulary has exactly one
  // authority (`normalizeMode`), so a missing, empty or wrong-typed mode and an
  // unsupported string all produce the same actionable SANDBOX_INVALID_MODE with
  // the accepted list attached, instead of splitting into two codes.
  const mode = body?.mode;
  const found = await findSessionRow(services, sessionId);
  const timeout = withTimeout(services.requestTimeoutMs);
  try {
    return await setSandboxState(services, sessionId, mode, {
      signal: timeout.signal,
      row: { cwd: found.cwd },
    });
  } catch (error) {
    throw classifyDsh(error, { operation: 'session.sandbox.set', sessionId });
  } finally {
    timeout.cancel();
  }
}

/**
 * `session.cancel` — request cancellation of the session's running work.
 * @param services - the resolved services.
 * @param sessionId - the target session.
 * @returns `{sessionId, accepted}`.
 */
export async function cancelSession(services, sessionId) {
  try {
    // The host declaration types this as synchronous, but awaiting it costs
    // nothing and keeps a promise-returning implementation correct.
    const value = await services.sessionController.cancel({ sessionId });
    return { sessionId, accepted: value?.accepted !== false };
  } catch (error) {
    throw classifyDsh(error, { operation: 'session.cancel', sessionId });
  }
}
