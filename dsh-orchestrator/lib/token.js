/**
 * The control token: where it lives, how it is minted, how it is compared.
 *
 * The token is **not** stored by this plugin. It lives in DSH's own credential
 * store as the record `dsh-orchestrator/control-token`, which is the seam DSH
 * built for exactly this ("what credential does this plugin hold for this id").
 * Using it buys four things over a hand-rolled file, all of them verified in
 * the installed 0.2.0-rc.2 sources:
 *
 *   * `modifyRecord` is a serialized read-modify-write under a cross-process
 *     file lock (`@deepseek-ai/dsh-atomic-write`), so two DSH processes booting
 *     at once cannot mint two different tokens.
 *   * `dsh-credentials-local` writes the document with mode 0600 / dirMode 0700
 *     on every commit, and `assertOwnerOnly()` refuses to start when the file
 *     is readable beyond its owner. That check is DSH's, not ours, so it cannot
 *     be forgotten here.
 *   * The document is parsed strictly and unrelated entries are preserved, so
 *     our record cannot damage the DeepSeek key sitting next to it.
 *   * Nothing is written by us, so there is no ACL or umask question to answer.
 *
 * We cannot `import` `@deepseek-ai/dsh-credentials` — a plugin installed into
 * `$DSH_HOME/profiles/<name>` cannot resolve packages out of the global DSH
 * install (this is why the reference implementation avoids such imports too).
 * `CredentialKey` is a branded string with no runtime representation, so the
 * joined key is passed literally; the segment grammar is re-asserted here
 * against the same pattern DSH uses.
 *
 * @module dsh-orchestrator/token
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

import { CODES, fail } from './errors.js';

/**
 * Mirrors `KEY_SEGMENT_PATTERN` in `@deepseek-ai/dsh-credentials/lib/index.js`.
 * Duplicated because it cannot be imported; `assertTokenKeyGrammar()` below is
 * what keeps the duplication honest (a unit test calls it on every boot path).
 */
export const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Owning-plugin scope of the record. Must satisfy {@link KEY_SEGMENT_PATTERN}. */
export const TOKEN_SCOPE = 'dsh-orchestrator';

/** Plugin-chosen addressing unit. Must satisfy {@link KEY_SEGMENT_PATTERN}. */
export const TOKEN_ID = 'control-token';

/** The joined `<scope>/<id>` record address. */
export const TOKEN_KEY = `${TOKEN_SCOPE}/${TOKEN_ID}`;

/** Payload layout version, so a future change can be detected rather than guessed. */
export const TOKEN_PAYLOAD_VERSION = 1;

/** 32 bytes = 256 bits of CSPRNG entropy, hex-encoded to 64 characters. */
const TOKEN_BYTES = 32;

/** Shortest accepted value for a caller-pinned `config.token`. */
const MIN_CONFIGURED_TOKEN_LENGTH = 32;

/**
 * Assert the compiled-in record address satisfies DSH's segment grammar.
 * @throws {OrchestratorError} GATE_FAILED when it does not.
 */
export function assertTokenKeyGrammar() {
  for (const [label, segment] of [['scope', TOKEN_SCOPE], ['id', TOKEN_ID]]) {
    if (!KEY_SEGMENT_PATTERN.test(segment)) {
      throw fail(CODES.GATE_FAILED, `control token ${label} "${segment}" is not a lowercase hyphenated identifier`);
    }
  }
}

/**
 * Extract the token from the `Authorization` header.
 * Only `Bearer` is accepted, and the scheme is matched case-insensitively
 * because HTTP auth schemes are case-insensitive by specification.
 * @param headerValue - the raw header value.
 * @returns the offered token, or `undefined`.
 */
export function parseBearer(headerValue) {
  if (typeof headerValue !== 'string') return undefined;
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(headerValue);
  return match === null ? undefined : match[1];
}

/**
 * Constant-time token comparison.
 *
 * The empty case is rejected explicitly. The reference implementation's proxy
 * half omitted that guard, which would have left it wide open to an empty
 * token had `resolveToken` ever returned one. Here it is unreachable by
 * construction, and the guard keeps it that way.
 * @param offered - the presented token.
 * @param expected - the configured token.
 * @returns whether the two match.
 */
export function tokenMatches(offered, expected) {
  if (typeof offered !== 'string' || typeof expected !== 'string') return false;
  if (offered.length === 0 || expected.length === 0) return false;
  const left = Buffer.from(offered, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Read our token out of one stored record, failing loudly on a foreign shape.
 * A malformed record is never silently replaced: that would invalidate a token
 * an orchestrator is already using, and would hide store corruption.
 * @param record - the value returned by the credential store.
 * @returns the token string.
 * @throws {OrchestratorError} GATE_FAILED when the record is not ours.
 */
function tokenFromRecord(record) {
  if (record === null || typeof record !== 'object' || record.kind !== 'grant') {
    throw fail(CODES.GATE_FAILED, `credential record "${TOKEN_KEY}" is not the grant record this plugin owns`, {
      key: TOKEN_KEY,
      foundKind: record !== null && typeof record === 'object' && typeof record.kind === 'string' ? record.kind : null,
    });
  }
  const payload = record.payload;
  if (payload === null || typeof payload !== 'object') {
    throw fail(CODES.GATE_FAILED, `credential record "${TOKEN_KEY}" has no payload object`, { key: TOKEN_KEY });
  }
  const token = payload.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw fail(CODES.GATE_FAILED, `credential record "${TOKEN_KEY}" carries no token string`, { key: TOKEN_KEY });
  }
  return token;
}

/**
 * Resolve the control token: an operator-pinned one, else the stored one, else
 * a freshly minted one committed under the store's cross-process lock.
 * @param ctx - the Cordis context.
 * @param config - the resolved plugin config.
 * @returns `{token, source, key}`. `key` is `null` for a pinned token.
 * @throws {OrchestratorError} GATE_FAILED when no token can be established.
 */
export async function resolveControlToken(ctx, config) {
  if (typeof config.token === 'string' && config.token.length > 0) {
    if (config.token.length < MIN_CONFIGURED_TOKEN_LENGTH) {
      throw fail(CODES.GATE_FAILED, `config.token must be at least ${MIN_CONFIGURED_TOKEN_LENGTH} characters`, {
        length: config.token.length,
        minimum: MIN_CONFIGURED_TOKEN_LENGTH,
      });
    }
    return { token: config.token, source: 'config', key: null };
  }

  assertTokenKeyGrammar();

  const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined;
  if (
    credentials === undefined ||
    credentials === null ||
    typeof credentials.readRecord !== 'function' ||
    typeof credentials.modifyRecord !== 'function'
  ) {
    throw fail(
      CODES.GATE_FAILED,
      'ctx.credentials is unavailable, so the control token cannot be established; this plugin refuses to fall back to a token file',
    );
  }

  const existing = await credentials.readRecord(TOKEN_KEY);
  if (existing !== undefined) {
    return { token: tokenFromRecord(existing), source: 'credential-store', key: TOKEN_KEY };
  }

  const candidate = {
    kind: 'grant',
    payload: { version: TOKEN_PAYLOAD_VERSION, token: randomBytes(TOKEN_BYTES).toString('hex') },
  };
  // Returning `undefined` declines the write, so an existing record is never
  // overwritten; the store hands back the record that stands.
  const settled = await credentials.modifyRecord(TOKEN_KEY, async (current) =>
    current === undefined ? candidate : undefined,
  );
  if (settled === undefined) {
    throw fail(CODES.GATE_FAILED, `credential store declined to store "${TOKEN_KEY}"`, { key: TOKEN_KEY });
  }
  return { token: tokenFromRecord(settled), source: 'credential-store', key: TOKEN_KEY };
}
