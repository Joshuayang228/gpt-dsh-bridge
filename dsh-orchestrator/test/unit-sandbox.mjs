/**
 * Unit tests for the sandbox seam.
 *
 * These run against fakes rather than a live Host, which is what lets them pin
 * the parts that a live run cannot easily show: that a cold session is refused
 * the write, that two sessions never share a mode, that an unsupported mode is
 * rejected instead of coerced, and that nothing in the source can escalate on
 * its own.
 *
 * The fakes mirror the two real seams exactly:
 *   - `sessionController.projections()` works without a handle (persisted fold).
 *   - `ctx.sessions.get(id)` returns live sessions only.
 *   - a switch is one `sandbox/mode` append, folded per session.
 *
 * @module dsh-orchestrator/test/unit-sandbox
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES, httpStatus } from '../lib/errors.js';
import { readSandboxState, sandboxOfRow, SANDBOX_MODES, setSandboxState } from '../lib/sandbox.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib');
const read = (name) => readFileSync(path.join(LIB, name), 'utf8');

/**
 * Build a fake world matching DSH's real seams.
 * @param options - the deployment default and fallback root.
 * @returns the fakes plus a session factory.
 */
function makeWorld(options = {}) {
  const { defaultMode = 'read-only', deploymentRoot = 'C:/deploy-root' } = options;
  const overrides = new Map();
  const live = new Map();

  const sandboxPolicy = {
    defaultMode,
    workspaceRoot: deploymentRoot,
    overrideOf(session) {
      return overrides.get(session.id);
    },
    resolve(request = {}) {
      const session = request.session;
      return {
        mode: request.mode ?? (session === undefined ? undefined : overrides.get(session.id)) ?? defaultMode,
        workspaceRoot: session?.header?.cwd ?? deploymentRoot,
      };
    },
  };

  const sessions = {
    get(id) {
      return live.get(id);
    },
  };

  const sessionController = {
    async projections({ sessionId }) {
      const value = overrides.get(sessionId);
      return { asOfSeq: 7, values: { sandboxMode: value ?? null } };
    },
  };

  /**
   * Register a live session whose `append` folds like the real projection.
   * @returns the fake session.
   */
  function addSession(id, cwd) {
    const events = [];
    const session = {
      id,
      header: { cwd },
      events,
      append(type, data) {
        events.push({ type, data });
        if (type === 'sandbox/mode') overrides.set(id, data.mode);
      },
    };
    live.set(id, session);
    return session;
  }

  return { services: { sandboxPolicy, sessions, sessionController }, addSession, overrides, live };
}

/** Assert a thrown OrchestratorError carries a code. */
function expectCode(fn, code) {
  try {
    const value = fn();
    if (value instanceof Promise) throw new Error('expected a synchronous throw');
  } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code} (${error.message})`);
    return error;
  }
  assert.fail(`expected a throw with ${code}`);
}

/** Assert a rejected promise carries a code. */
async function expectRejectCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code} (${error.message})`);
    return error;
  }
  assert.fail(`expected a rejection with ${code}`);
}

// ------------------------------------------------------------- mode vocabulary

test('the accepted vocabulary is exactly the three DSH modes', () => {
  assert.deepEqual([...SANDBOX_MODES], ['read-only', 'workspace-write', 'danger-full-access']);
  assert.ok(Object.isFrozen(SANDBOX_MODES));
});

test('reading on a cold session returns the deployment default and is not writable', async () => {
  const world = makeWorld({ defaultMode: 'read-only' });
  world.addSession('cold', 'C:/proj');
  world.live.clear(); // persisted but not live

  const state = await readSandboxState(world.services, 'cold', { row: { cwd: 'C:/proj' } });
  assert.equal(state.mode, 'read-only');
  assert.equal(state.modeSource, 'deployment-default');
  assert.equal(state.writable, false);
  assert.equal(state.asOfSeq, 7);
});

test('a logged override outranks the deployment default on a cold session', async () => {
  const world = makeWorld({ defaultMode: 'read-only' });
  world.overrides.set('cold', 'workspace-write');

  const state = await readSandboxState(world.services, 'cold', { row: { cwd: 'C:/proj' } });
  assert.equal(state.mode, 'workspace-write');
  assert.equal(state.modeSource, 'session');
});

test('workspaceRoot comes from the session cwd, not the deployment fallback', async () => {
  const world = makeWorld({ defaultMode: 'workspace-write', deploymentRoot: 'C:/deploy-root' });
  const state = await readSandboxState(world.services, 'cold', { row: { cwd: 'D:/proj/root' } });
  assert.equal(state.workspaceRoot, 'D:/proj/root');
  assert.equal(state.workspaceRootSource, 'session-cwd');
});

test('the deployment root is used only when the session has no cwd', async () => {
  const world = makeWorld({ defaultMode: 'workspace-write', deploymentRoot: 'C:/deploy-root' });
  const state = await readSandboxState(world.services, 'cold', { row: { cwd: null } });
  assert.equal(state.workspaceRoot, 'C:/deploy-root');
  assert.equal(state.workspaceRootSource, 'deployment-default');
});

test('a live session is read through the official resolver and reports writable', async () => {
  const world = makeWorld({ defaultMode: 'read-only' });
  world.addSession('live', 'C:/proj');
  world.overrides.set('live', 'danger-full-access');

  const state = await readSandboxState(world.services, 'live', { row: { cwd: 'C:/proj' } });
  assert.equal(state.mode, 'danger-full-access');
  assert.equal(state.modeSource, 'session');
  assert.equal(state.writable, true);
});

// -------------------------------------------------------------- explicit write

test('switching a cold session is refused and appends nothing', async () => {
  const world = makeWorld({ defaultMode: 'read-only' });
  const session = world.addSession('cold', 'C:/proj');
  world.live.clear();

  const error = await expectRejectCode(setSandboxState(world.services, 'cold', 'danger-full-access'), CODES.SESSION_NOT_LIVE);
  assert.equal(httpStatus(error.code), 409);
  assert.equal(session.events.length, 0, 'a refused switch must not append');
  assert.equal(world.overrides.has('cold'), false);
});

test('switching a live session appends exactly one sandbox/mode event', async () => {
  const world = makeWorld({ defaultMode: 'read-only' });
  const session = world.addSession('live', 'C:/proj');

  const result = await setSandboxState(world.services, 'live', 'workspace-write', { row: { cwd: 'C:/proj' } });

  assert.equal(session.events.length, 1);
  assert.deepEqual(session.events[0], { type: 'sandbox/mode', data: { mode: 'workspace-write' } });
  assert.equal(result.previousMode, 'read-only');
  assert.equal(result.mode, 'workspace-write');
  assert.equal(result.changed, true);
  assert.equal(result.verified, true);
});

test('re-applying the same mode still writes and reports changed:false', async () => {
  const world = makeWorld({ defaultMode: 'read-only' });
  const session = world.addSession('live', 'C:/proj');

  await setSandboxState(world.services, 'live', 'read-only', { row: { cwd: 'C:/proj' } });
  const second = await setSandboxState(world.services, 'live', 'read-only', { row: { cwd: 'C:/proj' } });

  assert.equal(session.events.length, 2);
  assert.equal(second.changed, false);
  assert.equal(second.verified, true);
});

test('read-back after a switch reports the new mode, proving the fold took it', async () => {
  const world = makeWorld({ defaultMode: 'read-only' });
  world.addSession('live', 'C:/proj');

  await setSandboxState(world.services, 'live', 'danger-full-access', { row: { cwd: 'C:/proj' } });
  const reread = await readSandboxState(world.services, 'live', { row: { cwd: 'C:/proj' } });
  assert.equal(reread.mode, 'danger-full-access');
  assert.equal(reread.modeSource, 'session');
});

// ------------------------------------------------------------- session isolation

test('a switch is per session and cannot leak to another session', async () => {
  const world = makeWorld({ defaultMode: 'read-only' });
  world.addSession('a', 'C:/a');
  world.addSession('b', 'C:/b');

  await setSandboxState(world.services, 'a', 'danger-full-access', { row: { cwd: 'C:/a' } });

  const a = await readSandboxState(world.services, 'a', { row: { cwd: 'C:/a' } });
  const b = await readSandboxState(world.services, 'b', { row: { cwd: 'C:/b' } });

  assert.equal(a.mode, 'danger-full-access');
  assert.equal(b.mode, 'read-only', 'session b must be untouched');
  assert.equal(b.modeSource, 'deployment-default');
});

test('two sessions keep independent overrides in the persisted fold', async () => {
  const world = makeWorld({ defaultMode: 'read-only' });
  world.addSession('a', 'C:/a');
  world.addSession('b', 'C:/b');

  await setSandboxState(world.services, 'a', 'workspace-write', { row: { cwd: 'C:/a' } });
  await setSandboxState(world.services, 'b', 'danger-full-access', { row: { cwd: 'C:/b' } });

  world.live.clear(); // both now read as cold
  const a = await readSandboxState(world.services, 'a', { row: { cwd: 'C:/a' } });
  const b = await readSandboxState(world.services, 'b', { row: { cwd: 'C:/b' } });
  assert.equal(a.mode, 'workspace-write');
  assert.equal(b.mode, 'danger-full-access');
});

// ------------------------------------------------------------- rejection paths

test('an unsupported mode is rejected, never coerced or defaulted', async () => {
  for (const value of ['full-access', 'DANGER-FULL-ACCESS', '', ' workspace-write', 'readonly', 'none']) {
    const world = makeWorld();
    const session = world.addSession('live', 'C:/proj');
    const error = await expectRejectCode(
      setSandboxState(world.services, 'live', value, { row: { cwd: 'C:/proj' } }),
      CODES.SANDBOX_INVALID_MODE,
    );
    assert.equal(httpStatus(error.code), 400);
    assert.equal(session.events.length, 0, `"${value}" must not write`);
    assert.deepEqual(error.details.available, [...SANDBOX_MODES]);
  }
});

test('a non-string mode is rejected rather than interpreted', async () => {
  const world = makeWorld();
  world.addSession('live', 'C:/proj');
  for (const value of [undefined, null, 0, true, {}, []]) {
    await expectRejectCode(
      setSandboxState(world.services, 'live', value, { row: { cwd: 'C:/proj' } }),
      CODES.SANDBOX_INVALID_MODE,
    );
  }
});

test('a missing policy service refuses instead of assuming a permissive default', async () => {
  const world = makeWorld();
  const services = { ...world.services, sandboxPolicy: undefined };
  await expectRejectCode(readSandboxState(services, 'x', {}), CODES.SANDBOX_UNAVAILABLE);
  // Mode validation runs first, so a bad value still reports as a bad value.
  await expectRejectCode(setSandboxState(services, 'x', 'nope', {}), CODES.SANDBOX_INVALID_MODE);
  const error = await expectRejectCode(setSandboxState(services, 'x', 'read-only', {}), CODES.SANDBOX_UNAVAILABLE);
  assert.equal(httpStatus(error.code), 501);
  // The point of the test: an unavailable policy never yields a permissive mode
  // and never falls back to one to keep going.
  assert.doesNotMatch(error.message, /read-only|workspace-write|danger-full-access/);
});

test('sandboxOfRow degrades to null without a policy service', () => {
  assert.equal(sandboxOfRow({ cwd: 'C:/p', sandboxModeOverride: null }, {}), null);
});

test('sandboxOfRow mirrors the override and the effective source', () => {
  const world = makeWorld({ defaultMode: 'read-only' });
  const off = sandboxOfRow({ cwd: 'C:/p', sandboxModeOverride: null }, world.services);
  assert.equal(off.mode, 'read-only');
  assert.equal(off.modeSource, 'deployment-default', 'a present null proves the session has no override');
  assert.equal(off.authoritative, true);

  const on = sandboxOfRow({ cwd: 'C:/p', sandboxModeOverride: 'workspace-write' }, world.services);
  assert.equal(on.mode, 'workspace-write');
  assert.equal(on.modeSource, 'session');
  assert.equal(on.workspaceRoot, 'C:/p');
  assert.equal(on.authoritative, true);
});

test('sandboxOfRow says "unknown" rather than inventing a source', () => {
  // The regression this pins: a row that simply lacks the projection unit used
  // to be reported as `deployment-default`, which asserted something the row
  // never proved. On a live session that produced a row saying
  // `deployment-default` while the dedicated endpoint said `session`.
  const world = makeWorld({ defaultMode: 'workspace-write' });
  const blind = sandboxOfRow({ cwd: 'C:/p' }, world.services);
  assert.equal(blind.modeSource, 'unknown');
  assert.equal(blind.authoritative, false);
  assert.equal(blind.modeIsDeploymentDefault, true);
  assert.equal(blind.mode, 'workspace-write', 'the value shown is the deployment default');
  assert.equal(blind.workspaceRoot, 'C:/p');

  // A row that does carry the unit stays authoritative.
  const seeing = sandboxOfRow({ cwd: 'C:/p', sandboxModeOverride: 'read-only' }, world.services);
  assert.equal(seeing.modeSource, 'session');
  assert.equal(seeing.authoritative, true);
});

// ------------------------------------------- structural: no automatic escalation

test('the write is unreachable except through the explicit sandbox route', () => {
  const index = read('index.js');
  // Exactly one dispatch arm may reach the switch, and it must be the sandbox
  // POST branch. Any second call site would be an escalation path.
  const calls = index.match(/handlers\.setSandbox\b/g) ?? [];
  assert.equal(calls.length, 1, `expected one setSandbox call site, saw ${calls.length}`);
  const arm = index.slice(index.indexOf("if (action === 'sandbox')"), index.indexOf("if (action === 'sandbox')") + 520);
  assert.match(arm, /handlers\.setSandbox/);
});

test('no handler escalates after a prompt, denial, or path rejection', () => {
  const handlers = read('handlers.js');
  // The prompt and cancel paths must not mention permission at all.
  const promptStart = handlers.indexOf('export async function promptSession');
  const promptEnd = handlers.indexOf('export async function sessionStatus');
  assert.ok(promptStart > 0 && promptEnd > promptStart);
  const promptBody = handlers.slice(promptStart, promptEnd);
  assert.doesNotMatch(promptBody, /sandbox|SANDBOX|danger-full-access/);
});

test('danger-full-access never appears as a default, fallback, or literal mode', () => {
  // It may appear only inside the vocabulary list and in prose. A code line that
  // assigns it, or compares against it to pick it, would be an escalation.
  for (const file of ['sandbox.js', 'handlers.js', 'index.js', 'gate.js']) {
    const source = read(file);
    for (const line of source.split(/\r?\n/)) {
      if (!line.includes('danger-full-access')) continue;
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').trim();
      if (code.length === 0) continue; // prose in a block comment
      assert.match(
        code,
        /danger-full-access'\]|'read-only', 'workspace-write', 'danger-full-access'|'danger-full-access'\]|SANDBOX_MODES|modes: \[/,
        `${file}: unexpected use of the mode: ${code}`,
      );
    }
  }
});

test('the switch is never called as a retry or fallback helper', () => {
  // Count appends in code only: the module prose also mentions `session.append`.
  const codeOnly = read('sandbox.js')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .filter((line) => !/^\s*\*/.test(line))
    .join('\n');
  const appends = codeOnly.match(/\.append\(/g) ?? [];
  assert.equal(appends.length, 1, `expected exactly one append, saw ${appends.length}`);
  assert.match(codeOnly, /\.append\('sandbox\/mode', \{ mode: wanted \}\)/);
});
