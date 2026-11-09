/**
 * Token tests. Pure: a fake credential store stands in for `ctx.credentials`,
 * so nothing here needs DSH installed or a profile.
 *
 * The `tokenMatches('', '')` case is a regression guard. The reference
 * implementation's proxy half compared without a non-empty precondition, which
 * left it open to an empty token; here that is impossible twice over — the
 * mint never produces an empty value, and the comparison refuses one.
 *
 * @module dsh-orchestrator/test/unit-token
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CODES } from '../lib/errors.js';
import {
  KEY_SEGMENT_PATTERN,
  TOKEN_ID,
  TOKEN_KEY,
  TOKEN_PAYLOAD_VERSION,
  TOKEN_SCOPE,
  assertTokenKeyGrammar,
  parseBearer,
  resolveControlToken,
  tokenMatches,
} from '../lib/token.js';

/**
 * A store that mimics the two properties that matter: `mutate` decides under
 * exclusion, and a declined mutate returns whatever currently stands.
 * @param initial - the record the store starts with, if any.
 * @returns the store plus a peek helper.
 */
function fakeCredentials(initial) {
  let record = initial;
  let tail = Promise.resolve();
  return {
    async readRecord(key) {
      assert.equal(key, TOKEN_KEY);
      return record;
    },
    modifyRecord(key, mutate) {
      assert.equal(key, TOKEN_KEY);
      // Serialized like the real provider's writer lock.
      const run = tail.then(async () => {
        const next = await mutate(record);
        if (next !== undefined) record = next;
        return record;
      });
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    peek() {
      return record;
    },
  };
}

/**
 * A Cordis-shaped context exposing one service.
 * @param services - service map.
 * @returns the fake context.
 */
function fakeCtx(services) {
  return { get: (name) => services[name] };
}

const HEX_64 = /^[0-9a-f]{64}$/;

test('the record address satisfies the grammar DSH enforces', () => {
  assertTokenKeyGrammar();
  assert.match(TOKEN_SCOPE, KEY_SEGMENT_PATTERN);
  assert.match(TOKEN_ID, KEY_SEGMENT_PATTERN);
  assert.equal(TOKEN_KEY, `${TOKEN_SCOPE}/${TOKEN_ID}`);
});

test('an empty store mints a 256-bit token and stores it as a grant record', async () => {
  const store = fakeCredentials(undefined);
  const resolved = await resolveControlToken(fakeCtx({ credentials: store }), {});
  assert.equal(resolved.source, 'credential-store');
  assert.equal(resolved.key, TOKEN_KEY);
  assert.match(resolved.token, HEX_64);
  assert.deepEqual(store.peek(), {
    kind: 'grant',
    payload: { version: TOKEN_PAYLOAD_VERSION, token: resolved.token },
  });
});

test('an existing token is reused and never overwritten', async () => {
  const existing = {
    kind: 'grant',
    payload: { version: TOKEN_PAYLOAD_VERSION, token: 'a'.repeat(64) },
  };
  const store = fakeCredentials(existing);
  const resolved = await resolveControlToken(fakeCtx({ credentials: store }), {});
  assert.equal(resolved.token, 'a'.repeat(64));
  assert.equal(store.peek(), existing);
});

test('two concurrent resolutions settle on one token', async () => {
  const store = fakeCredentials(undefined);
  const ctx = fakeCtx({ credentials: store });
  const [first, second] = await Promise.all([resolveControlToken(ctx, {}), resolveControlToken(ctx, {})]);
  assert.equal(first.token, second.token);
  assert.equal(store.peek().payload.token, first.token);
});

test('a foreign record kind is refused rather than replaced', async () => {
  const store = fakeCredentials({ kind: 'api-key', key: 'x' });
  await assert.rejects(
    resolveControlToken(fakeCtx({ credentials: store }), {}),
    (error) => error.code === CODES.GATE_FAILED && error.details.foundKind === 'api-key',
  );
  assert.equal(store.peek().kind, 'api-key', 'the foreign record must be left alone');
});

test('a grant record without a token string is refused', async () => {
  const store = fakeCredentials({ kind: 'grant', payload: { version: 1 } });
  await assert.rejects(
    resolveControlToken(fakeCtx({ credentials: store }), {}),
    (error) => error.code === CODES.GATE_FAILED,
  );
});

test('a missing credential service fails loudly instead of using a file', async () => {
  await assert.rejects(
    resolveControlToken(fakeCtx({}), {}),
    (error) => error.code === CODES.GATE_FAILED && /refuses to fall back to a token file/.test(error.message),
  );
});

test('a pinned token is used as-is and leaves the store untouched', async () => {
  const store = fakeCredentials(undefined);
  const pinned = 'p'.repeat(48);
  const resolved = await resolveControlToken(fakeCtx({ credentials: store }), { token: pinned });
  assert.equal(resolved.token, pinned);
  assert.equal(resolved.source, 'config');
  assert.equal(resolved.key, null);
  assert.equal(store.peek(), undefined);
});

test('a short pinned token is refused', async () => {
  await assert.rejects(
    resolveControlToken(fakeCtx({ credentials: fakeCredentials(undefined) }), { token: 'short' }),
    (error) => error.code === CODES.GATE_FAILED && error.details.minimum === 32,
  );
});

test('an empty token never matches, including empty against empty', () => {
  assert.equal(tokenMatches('', ''), false);
  assert.equal(tokenMatches('', 'x'), false);
  assert.equal(tokenMatches('x', ''), false);
  assert.equal(tokenMatches(undefined, undefined), false);
  assert.equal(tokenMatches(null, 'x'), false);
});

test('tokenMatches requires an exact, same-length match', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abcd'), false);
  assert.equal(tokenMatches('abc', 'abd'), false);
  assert.equal(tokenMatches('ABC', 'abc'), false);
});

test('parseBearer accepts only the Bearer scheme, case-insensitively', () => {
  assert.equal(parseBearer('Bearer abc'), 'abc');
  assert.equal(parseBearer('bearer abc'), 'abc');
  assert.equal(parseBearer('  BEARER   abc  '), 'abc');
  assert.equal(parseBearer('Basic abc'), undefined);
  assert.equal(parseBearer('abc'), undefined);
  assert.equal(parseBearer(''), undefined);
  assert.equal(parseBearer(undefined), undefined);
  assert.equal(parseBearer(['Bearer abc']), undefined);
});
