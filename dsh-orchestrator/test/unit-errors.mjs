/**
 * Classifier and envelope tests. Pure: no DSH, no install, no network.
 *
 * The writer-held cases are the important ones. DSH reports that failure in
 * three different shapes depending on which layer raises it, and an
 * orchestrator that cannot tell "busy" from "broken" is exactly the fragility
 * this plugin exists to remove.
 *
 * @module dsh-orchestrator/test/unit-errors
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CODES,
  OrchestratorError,
  classifyDsh,
  dshRemoteCode,
  errorBody,
  fail,
  httpStatus,
  messageOf,
  optionalString,
  requireString,
} from '../lib/errors.js';

/** Shape (a): the official cross-realm RemoteError. */
function remoteError(code, message) {
  return Object.assign(new Error(message), { isDSHRemoteError: true, code });
}

/** Shape (b): the bare persistence-lease error. */
function ownedError(sessionId) {
  const error = new Error(`session "${sessionId}" is already owned by an active write handle`);
  error.name = 'SessionAlreadyOwnedError';
  return error;
}

test('writer-held maps from the official RemoteError marker', () => {
  const mapped = classifyDsh(remoteError('session/writer-held', 'busy'), { sessionId: 's1' });
  assert.equal(mapped.code, CODES.SESSION_ACTIVE_WRITER);
  assert.equal(httpStatus(mapped.code), 409);
  assert.deepEqual(mapped.details, { sessionId: 's1' });
});

test('writer-held maps from a bare SessionAlreadyOwnedError', () => {
  const mapped = classifyDsh(ownedError('s2'), { sessionId: 's2' });
  assert.equal(mapped.code, CODES.SESSION_ACTIVE_WRITER);
  assert.equal(mapped.details.sessionId, 's2');
});

test('writer-held maps from the message alone, so a shape change still resolves', () => {
  const mapped = classifyDsh(new Error('session "s3" is already owned by an active write handle'), {});
  assert.equal(mapped.code, CODES.SESSION_ACTIVE_WRITER);
});

test('every writer-held shape produces the same code and status', () => {
  const shapes = [
    remoteError('session/writer-held', 'x'),
    ownedError('s'),
    new Error('session "s" is already owned by an active write handle'),
  ];
  const codes = shapes.map((shape) => classifyDsh(shape, {}).code);
  const statuses = codes.map((code) => httpStatus(code));
  assert.deepEqual(codes, [CODES.SESSION_ACTIVE_WRITER, CODES.SESSION_ACTIVE_WRITER, CODES.SESSION_ACTIVE_WRITER]);
  assert.deepEqual(statuses, [409, 409, 409]);
});

test('the attach cwd gate maps to SESSION_CWD_MISMATCH with the workspace path kept', () => {
  const gate = new Error(
    "cannot attach session 'session-1' to workspace 'D:\\proj': its cwd resolves to 'D:\\other'",
  );
  const mapped = classifyDsh(gate, { sessionId: 'session-1', workspaceId: 'w1', workspacePath: 'D:\\proj' });
  assert.equal(mapped.code, CODES.SESSION_CWD_MISMATCH);
  assert.equal(httpStatus(mapped.code), 409);
  assert.equal(mapped.details.workspacePath, 'D:\\proj');
});

test('a missing stored cwd maps to the same code', () => {
  const gate = new Error(
    "cannot attach session 's' to workspace 'D:\\p': its stored header carries no cwd to validate against",
  );
  assert.equal(classifyDsh(gate, {}).code, CODES.SESSION_CWD_MISMATCH);
});

test('recognised DSH codes map onto this surface vocabulary', () => {
  const table = {
    'session/not-found': CODES.SESSION_NOT_FOUND,
    'session/agent-busy': CODES.SESSION_AGENT_BUSY,
    'session/title-invalid': CODES.TITLE_INVALID,
    'workspace/not-found': CODES.WORKSPACE_NOT_FOUND,
    'session/workspace-attach-failed': CODES.WORKSPACE_ATTACH_FAILED,
    'gateway/bad-request': CODES.BAD_REQUEST,
  };
  for (const [dshCode, expected] of Object.entries(table)) {
    const mapped = classifyDsh(remoteError(dshCode, 'm'), {});
    assert.equal(mapped.code, expected, `${dshCode} should map to ${expected}`);
  }
});

test('an unrecognised DSH code becomes DSH_ERROR and keeps the upstream code', () => {
  const mapped = classifyDsh(remoteError('session/something-new', 'm'), {});
  assert.equal(mapped.code, CODES.DSH_ERROR);
  assert.equal(httpStatus(mapped.code), 502);
  assert.equal(mapped.details.dshCode, 'session/something-new');
});

test('an already-classified error passes through untouched', () => {
  const original = fail(CODES.TIMEOUT, 'slow');
  assert.equal(classifyDsh(original, {}), original);
});

test('the envelope only exposes INTERNAL for a genuine bug', () => {
  const bug = new TypeError('x is not a function');
  const body = errorBody(bug, { method: 'GET', path: '/v1/health' });
  assert.equal(body.ok, false);
  assert.equal(body.error.code, CODES.INTERNAL);
  assert.equal(httpStatus(body.error.code), 500);
});

test('a classified error keeps its own code in the envelope', () => {
  const body = errorBody(remoteError('session/writer-held', 'busy'), {});
  assert.equal(body.error.code, CODES.SESSION_ACTIVE_WRITER);
  assert.equal(body.error.message, 'busy');
});

test('details are omitted rather than emitted as undefined', () => {
  const body = errorBody(new OrchestratorError(CODES.BAD_REQUEST, 'no details'), {});
  assert.equal(Object.hasOwn(body.error, 'details'), false);
});

test('dshRemoteCode only trusts the official structural marker', () => {
  assert.equal(dshRemoteCode(remoteError('x', 'm')), 'x');
  assert.equal(dshRemoteCode({ code: 'x' }), undefined);
  assert.equal(dshRemoteCode(new Error('m')), undefined);
  assert.equal(dshRemoteCode(null), undefined);
});

test('messageOf survives cross-realm values', () => {
  assert.equal(messageOf('plain'), 'plain');
  assert.equal(messageOf(new Error('boom')), 'boom');
  assert.equal(messageOf({ name: 'N', message: 'M', code: 'C' }), 'N: M: C');
  assert.equal(messageOf(null), 'null');
});

test('requireString rejects blank and non-string values', () => {
  assert.equal(requireString({ a: ' x ' }, 'a'), 'x');
  assert.throws(() => requireString({ a: '   ' }, 'a'), /a is required/);
  assert.throws(() => requireString({}, 'a'), /a is required/);
  assert.throws(() => requireString({ a: 5 }, 'a'), /a is required/);
});

test('optionalString treats blank as absent', () => {
  assert.equal(optionalString({ a: ' x ' }, 'a'), 'x');
  assert.equal(optionalString({ a: '  ' }, 'a'), undefined);
  assert.equal(optionalString({}, 'a'), undefined);
});

test('every code has a status and none is a bare 200', () => {
  for (const code of Object.values(CODES)) {
    const status = httpStatus(code);
    assert.ok(Number.isInteger(status) && status >= 400, `${code} should map to a failure status, got ${status}`);
  }
});
