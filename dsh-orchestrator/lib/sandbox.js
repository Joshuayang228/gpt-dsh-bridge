/**
 * Sandbox-mode observability and explicit control.
 *
 * Why this module exists
 * ----------------------
 * A confined tool call can fail because of the session's file policy rather than
 * because of the code under test, and the failure text at the call site does not
 * always make that distinction obvious. An orchestrator that cannot see the mode
 * therefore re-derives the same wrong hypothesis instead of changing the policy.
 * Reading the effective mode is unconditional; changing it is an explicit act.
 *
 * How DSH models it (verified against 0.2.0-rc.2)
 * ----------------------------------------------
 * `@deepseek-ai/dsh-sandbox-policy` owns this. The session log IS the store:
 * a switch appends exactly one `sandbox/mode` event to that session, and
 * `effective = projection state ?? the deployment default`. There is no external
 * config file and nothing mutates mode state out of band.
 *
 * Two consequences shape this module:
 *   - Reading works on a cold session. `sessionController.projections()` goes
 *     through the official session query face, so the persisted fold is readable
 *     without attaching or resuming anything.
 *   - Writing needs a live session. `session.append` is only reachable on a live
 *     handle from `ctx.sessions.get(id)`, which returns live sessions only. That
 *     is why a switch on a cold session is refused rather than forced: the only
 *     way to make it live is to activate its Agent, and silently doing that to
 *     change a permission mode would be a surprising side effect.
 *
 * The write is a direct `session.append('sandbox/mode', { mode })` rather than an
 * import of the package's `setSandboxMode` helper, which is exactly this same
 * call. This plugin is installed into a profile and must not import DSH packages
 * (a test pins that), and the event payload is pinned by DSH's own
 * `SessionEventMap`. See `docs/decisions.md` for the trade.
 *
 * @module dsh-orchestrator/sandbox
 */

import { CODES, fail } from './errors.js';

/**
 * Every mode DSH accepts, mirroring `SANDBOX_MODES` in
 * `@deepseek-ai/dsh-sandbox-policy`. Kept here because importing the package is
 * not allowed from an installed plugin; any drift fails loudly as an upstream
 * error rather than silently accepting a value DSH would reject.
 */
export const SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access']);

const MODE_SET = new Set(SANDBOX_MODES);

/**
 * Validate an untrusted mode string. Never coerces, never defaults: a caller
 * that names an unsupported mode must find out rather than be quietly corrected.
 * @param value - the requested mode.
 * @returns the same string, narrowed.
 * @throws an `OrchestratorError` with `SANDBOX_INVALID_MODE`.
 */
export function normalizeMode(value) {
  if (typeof value === 'string' && MODE_SET.has(value)) return value;
  throw fail(CODES.SANDBOX_INVALID_MODE, `mode must be one of ${SANDBOX_MODES.join(', ')}`, {
    mode: value === undefined ? null : value,
    available: [...SANDBOX_MODES],
  });
}

/**
 * Require the policy service.
 *
 * It is fetched with `ctx.get` rather than listed in `inject` so this plugin
 * still mounts in a composition that omits it; the feature then reports itself
 * unavailable instead of taking the whole control surface down.
 * @param services - the resolved services.
 * @returns the policy service.
 * @throws an `OrchestratorError` with `SANDBOX_UNAVAILABLE` when absent.
 */
function requirePolicy(services) {
  const policy = services?.sandboxPolicy;
  if (policy === undefined || policy === null) {
    throw fail(
      CODES.SANDBOX_UNAVAILABLE,
      'the sandbox policy service is not mounted in this host, so sandbox state cannot be read or changed',
      {},
    );
  }
  return policy;
}

/**
 * Read the standing override without applying the deployment default.
 * @param policy - the policy service.
 * @param session - a live session handle.
 * @returns the override, or `null` when the log carries none.
 */
function overrideOfLive(policy, session) {
  if (typeof policy.overrideOf !== 'function') return null;
  const value = policy.overrideOf(session);
  return typeof value === 'string' ? value : null;
}

/**
 * Where the effective mode came from, which is the part a caller needs in order
 * to know whether switching will have any effect.
 * @param override - the standing session override, or `null`.
 * @param policy - the policy service.
 * @param row - the projected session row, when already available.
 * @returns the sandbox summary.
 */
function summarize({ override, mode, workspaceRoot, live, asOfSeq, policy, row }) {
  return {
    mode,
    modeSource: override === null ? 'deployment-default' : 'session',
    workspaceRoot,
    workspaceRootSource: row?.cwd == null ? 'deployment-default' : 'session-cwd',
    // Whether a switch is possible right now. Read-only callers can report this
    // without attempting anything.
    writable: live === true,
    available: [...SANDBOX_MODES],
    asOfSeq: asOfSeq ?? null,
  };
}

/**
 * Read one session's effective sandbox policy.
 *
 * Prefers the official resolver on a live handle, because that applies the real
 * precedence. Falls back to the persisted projection plus the deployment default
 * for a cold session, which is the same rule `resolve()` implements
 * (`override ?? defaultMode`).
 *
 * @param services - the resolved services.
 * @param sessionId - the target session.
 * @param options - `signal` for cancellation, `row` when the caller already has
 *   the projected session row (avoids a second read purely for the cwd).
 * @returns the sandbox summary.
 */
export async function readSandboxState(services, sessionId, options = {}) {
  const policy = requirePolicy(services);
  const { signal, row } = options;

  const live = typeof services.sessions?.get === 'function' ? services.sessions.get(sessionId) : undefined;
  if (live !== undefined) {
    const resolved = policy.resolve({ session: live });
    return summarize({
      override: overrideOfLive(policy, live),
      mode: resolved?.mode ?? null,
      workspaceRoot: resolved?.workspaceRoot ?? null,
      live: true,
      asOfSeq: null,
      policy,
      row,
    });
  }

  const projections = await services.sessionController.projections({ sessionId }, signal);
  const value = projections?.values?.sandboxMode;
  const override = typeof value === 'string' ? value : null;
  const cwd = row?.cwd ?? null;
  return summarize({
    override,
    mode: override ?? policy.defaultMode ?? null,
    workspaceRoot: cwd ?? policy.workspaceRoot ?? null,
    live: false,
    asOfSeq: projections?.asOfSeq ?? null,
    policy,
    row,
  });
}

/**
 * Compute the sandbox summary synchronously from a projected session row.
 *
 * `sessionController.list()` already carries every projection value, so this
 * costs no additional upstream call and can therefore ride along on every row.
 * @param row - the projected session row.
 * @param services - the resolved services.
 * @returns the sandbox summary, or `null` when the policy service is absent.
 */
export function sandboxOfRow(row, services) {
  const policy = services?.sandboxPolicy;
  if (policy === undefined || policy === null) return null;
  // A row only PROVES an answer when it actually carries the unit. A live row is
  // built from the full projection snapshot, but a cold row comes from the
  // persisted projection cache, which need not carry every unit. So:
  //   key present, null   -> proven: no override, the deployment default applies
  //   key present, string -> proven: the session overrides it
  //   key absent          -> unobservable here, and claiming a source would lie
  const known = row !== null && row !== undefined && Object.hasOwn(row, 'sandboxModeOverride');
  const override = known && typeof row.sandboxModeOverride === 'string' ? row.sandboxModeOverride : null;
  const cwd = row?.cwd ?? null;
  return {
    mode: known ? (override ?? (policy.defaultMode ?? null)) : (policy.defaultMode ?? null),
    modeSource: known ? (override === null ? 'deployment-default' : 'session') : 'unknown',
    // True when `mode` is only the deployment default and the session's own
    // override could not be seen, so `mode` may not be the effective mode.
    modeIsDeploymentDefault: !known || override === null,
    // False means: ask the dedicated endpoint, this row cannot answer.
    authoritative: known,
    workspaceRoot: cwd ?? policy.workspaceRoot ?? null,
    workspaceRootSource: cwd === null ? 'deployment-default' : 'session-cwd',
    available: [...SANDBOX_MODES],
  };
}

/**
 * Switch one session's sandbox mode.
 *
 * The switch is per session by construction: it appends to one session's log and
 * DSH's fold is per session, so no other session can observe it. It never
 * escalates on its own and is never called as a fallback from a failed prompt.
 *
 * @param services - the resolved services.
 * @param sessionId - the target session.
 * @param mode - the requested mode; validated exactly.
 * @param options - `signal` for cancellation, `row` for the cwd.
 * @returns the before/after summary plus whether the read-back matched.
 */
export async function setSandboxState(services, sessionId, mode, options = {}) {
  const wanted = normalizeMode(mode);
  const policy = requirePolicy(services);
  const { signal, row } = options;

  const session = typeof services.sessions?.get === 'function' ? services.sessions.get(sessionId) : undefined;
  if (session === undefined) {
    throw fail(
      CODES.SESSION_NOT_LIVE,
      'this session is not live in the host, so its log cannot be appended; DSH only exposes the mode switch on a live session. Prompt it once (or open it in the Web UI) and retry',
      { sessionId, mode: wanted },
    );
  }

  const before = await readSandboxState(services, sessionId, { signal, row });

  // THE write path: one event, exactly as the policy package's own helper does.
  session.append('sandbox/mode', { mode: wanted });

  // Read back through the official resolver rather than trusting the write.
  const resolved = policy.resolve({ session });
  const override = overrideOfLive(policy, session);
  const after = summarize({
    override,
    mode: resolved?.mode ?? null,
    workspaceRoot: resolved?.workspaceRoot ?? null,
    live: true,
    asOfSeq: null,
    policy,
    row,
  });

  return {
    sessionId,
    previousMode: before.mode,
    ...after,
    changed: before.mode !== after.mode,
    verified: after.mode === wanted,
  };
}
