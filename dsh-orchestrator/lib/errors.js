/**
 * Structured failure envelope and the DSH-signal classifier.
 *
 * Two rules shape this module:
 *
 * 1. Every failure this surface returns has a stable machine-readable `code`.
 *    An orchestrator must never have to regex a human message to decide whether
 *    a session is busy — that is the fragility this whole plugin exists to
 *    remove.
 *
 * 2. DSH signals arrive in three different shapes and all three must map to the
 *    same code. The shapes were verified against the installed 0.2.0-rc.2:
 *      (a) a `RemoteError` carrying `isDSHRemoteError: true` and a `code`
 *          (`@deepseek-ai/dsh-typert-protocol`, `remote-error.d.ts`) — this is
 *          the official cross-realm marker, so we check it instead of
 *          `instanceof`, which cannot work across bundles;
 *      (b) a bare `SessionAlreadyOwnedError` (`.name` + `.sessionId`, no
 *          `code`) thrown by the JSONL persistence lease;
 *      (c) a plain `Error` whose message is the only signal, which is what
 *          `WorkspaceEntity.attachSession` throws for its cwd gate.
 *
 * @module dsh-orchestrator/errors
 */

/** Stable codes emitted by this surface. */
export const CODES = Object.freeze({
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  TOKEN_IN_QUERY_FORBIDDEN: 'TOKEN_IN_QUERY_FORBIDDEN',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  NOT_FOUND: 'NOT_FOUND',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_ACTIVE_WRITER: 'SESSION_ACTIVE_WRITER',
  SESSION_AGENT_BUSY: 'SESSION_AGENT_BUSY',
  SESSION_CWD_MISMATCH: 'SESSION_CWD_MISMATCH',
  SESSION_NOT_LIVE: 'SESSION_NOT_LIVE',
  SANDBOX_INVALID_MODE: 'SANDBOX_INVALID_MODE',
  SANDBOX_UNAVAILABLE: 'SANDBOX_UNAVAILABLE',
  TITLE_INVALID: 'TITLE_INVALID',
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  WORKSPACE_ATTACH_FAILED: 'WORKSPACE_ATTACH_FAILED',
  WORKSPACE_ATTACH_UNSUPPORTED: 'WORKSPACE_ATTACH_UNSUPPORTED',
  DSH_ERROR: 'DSH_ERROR',
  GATE_FAILED: 'GATE_FAILED',
  TIMEOUT: 'TIMEOUT',
  INTERNAL: 'INTERNAL',
});

const STATUS = Object.freeze({
  [CODES.BAD_REQUEST]: 400,
  [CODES.TITLE_INVALID]: 400,
  [CODES.SANDBOX_INVALID_MODE]: 400,
  [CODES.TOKEN_IN_QUERY_FORBIDDEN]: 400,
  [CODES.UNAUTHORIZED]: 401,
  [CODES.NOT_FOUND]: 404,
  [CODES.SESSION_NOT_FOUND]: 404,
  [CODES.WORKSPACE_NOT_FOUND]: 404,
  [CODES.METHOD_NOT_ALLOWED]: 405,
  // 409 for every "the session is not in a state that accepts this" outcome.
  [CODES.SESSION_ACTIVE_WRITER]: 409,
  [CODES.SESSION_AGENT_BUSY]: 409,
  [CODES.SESSION_CWD_MISMATCH]: 409,
  [CODES.SESSION_NOT_LIVE]: 409,
  [CODES.WORKSPACE_ATTACH_FAILED]: 409,
  [CODES.SANDBOX_UNAVAILABLE]: 501,
  [CODES.WORKSPACE_ATTACH_UNSUPPORTED]: 501,
  [CODES.DSH_ERROR]: 502,
  [CODES.GATE_FAILED]: 503,
  [CODES.TIMEOUT]: 504,
  [CODES.INTERNAL]: 500,
});

/**
 * HTTP status for one code.
 * @param code - a {@link CODES} member.
 * @returns the status, defaulting to 500 for an unknown code.
 */
export function httpStatus(code) {
  return STATUS[code] ?? 500;
}

/** A failure this surface owns. `code` is the stable contract. */
export class OrchestratorError extends Error {
  /**
   * @param code - a {@link CODES} member.
   * @param message - human diagnostic.
   * @param details - optional machine-readable context.
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'OrchestratorError';
    /** Structural marker so the envelope builder never uses `instanceof`. */
    this.isOrchestratorError = true;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Build one {@link OrchestratorError}.
 * @param code - a {@link CODES} member.
 * @param message - human diagnostic.
 * @param details - optional machine-readable context.
 * @returns the error.
 */
export function fail(code, message, details) {
  return new OrchestratorError(code, message, details);
}

/** DSH `RemoteError` codes this surface understands, mapped onto its own. */
const DSH_CODE_MAP = Object.freeze({
  'session/writer-held': CODES.SESSION_ACTIVE_WRITER,
  'session/not-found': CODES.SESSION_NOT_FOUND,
  'session/agent-busy': CODES.SESSION_AGENT_BUSY,
  'session/title-invalid': CODES.TITLE_INVALID,
  'session/workspace-attach-failed': CODES.WORKSPACE_ATTACH_FAILED,
  'workspace/not-found': CODES.WORKSPACE_NOT_FOUND,
  'gateway/bad-request': CODES.BAD_REQUEST,
  'session/attachment-invalid': CODES.BAD_REQUEST,
  'session/invalid-time-zone': CODES.BAD_REQUEST,
  'session/queue-item-not-found': CODES.NOT_FOUND,
});

/**
 * The `WorkspaceEntity.attachSession` cwd gate throws plain `Error`s whose text
 * is the only signal. Verified against the installed 0.2.0-rc.2
 * (`@deepseek-ai/dsh-workspace/lib/types/entity.js:57-89`).
 */
const CWD_GATE_PATTERNS = Object.freeze([
  /its cwd resolves to/i,
  /carries no cwd to validate against/i,
  /is not a directory/i,
]);

const WRITER_HELD_PATTERN = /already owned by an active write handle/i;

/**
 * `WorkspaceEntity.attachSession` validates the session's stored header before
 * touching the account, and a session that does not exist is reported as a bare
 * `Error` from that read. Verified against
 * `@deepseek-ai/dsh-workspace/lib/types/entity.js` and its host
 * `readSessionHeader`.
 */
const SESSION_MISSING_PATTERNS = Object.freeze([
  /session persistence holds no such session/i,
  /cannot validate session/i,
]);

/**
 * Text for any thrown value, including cross-realm objects.
 * @param error - the thrown value.
 * @returns a diagnostic string.
 */
export function messageOf(error) {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === 'object') {
    const parts = [error.name, error.message, error.code].filter(
      (part) => typeof part === 'string' && part.length > 0,
    );
    if (parts.length > 0) return parts.join(': ');
    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}

/**
 * The DSH `RemoteError` code, read through the official structural marker.
 * @param error - a candidate thrown or returned value.
 * @returns the code, or `undefined` when this is not a DSH remote error.
 */
export function dshRemoteCode(error) {
  if (
    error !== null &&
    typeof error === 'object' &&
    error.isDSHRemoteError === true &&
    typeof error.code === 'string' &&
    error.code.length > 0
  ) {
    return error.code;
  }
  return undefined;
}

/**
 * Classify one failure raised at a DSH boundary into this surface's vocabulary.
 * @param error - the thrown value.
 * @param details - extra context merged into the result's details.
 * @returns an {@link OrchestratorError}, never throws.
 */
export function classifyDsh(error, details = {}) {
  if (error !== null && typeof error === 'object' && error.isOrchestratorError === true) return error;

  const name = error !== null && typeof error === 'object' && typeof error.name === 'string' ? error.name : undefined;
  const message = messageOf(error);
  const code = dshRemoteCode(error);

  // Layer 1-3: writer-held, by official code, by class name, then by message.
  if (code === 'session/writer-held' || name === 'SessionAlreadyOwnedError' || WRITER_HELD_PATTERN.test(message)) {
    return new OrchestratorError(CODES.SESSION_ACTIVE_WRITER, message, details);
  }
  // Layer 2: the attach cwd gate, which throws bare Errors.
  if (CWD_GATE_PATTERNS.some((pattern) => pattern.test(message))) {
    return new OrchestratorError(CODES.SESSION_CWD_MISMATCH, message, details);
  }
  // Layer 2b: the attach existence check, also a bare Error.
  if (SESSION_MISSING_PATTERNS.some((pattern) => pattern.test(message))) {
    return new OrchestratorError(CODES.SESSION_NOT_FOUND, message, details);
  }
  // Layer 3: a recognised DSH code.
  if (code !== undefined) {
    const mapped = DSH_CODE_MAP[code];
    return new OrchestratorError(mapped ?? CODES.DSH_ERROR, message, { ...details, dshCode: code });
  }
  // Unknown DSH-side failure: keep the text, mark it as upstream.
  return new OrchestratorError(CODES.DSH_ERROR, message, { ...details, dshCode: null });
}

/**
 * Whether a value carries a DSH signal this classifier understands, by any of
 * the three shapes. Used by {@link toEnvelope} so an unclassified upstream
 * failure still reports its real code instead of degrading to INTERNAL.
 * @param error - the candidate value.
 * @returns whether the value is a recognised DSH signal.
 */
export function recognisesDshSignal(error) {
  if (error === null || typeof error !== 'object') return false;
  if (dshRemoteCode(error) !== undefined) return true;
  if (typeof error.name === 'string' && error.name === 'SessionAlreadyOwnedError') return true;
  const message = messageOf(error);
  return (
    WRITER_HELD_PATTERN.test(message) ||
    CWD_GATE_PATTERNS.some((pattern) => pattern.test(message)) ||
    SESSION_MISSING_PATTERNS.some((pattern) => pattern.test(message))
  );
}

/**
 * Wrap any failure for the wire.
 *
 * Our own failures keep their code. A recognised DSH signal is classified, so
 * a handler that forgot to classify cannot turn an upstream fault into a
 * misleading INTERNAL. Anything else is a bug here and becomes INTERNAL, so it
 * is never reported as an upstream problem.
 * @param error - the thrown value.
 * @param details - extra context merged into an INTERNAL result.
 * @returns an {@link OrchestratorError}.
 */
export function toEnvelope(error, details = {}) {
  if (error !== null && typeof error === 'object' && error.isOrchestratorError === true) return error;
  if (recognisesDshSignal(error)) return classifyDsh(error, details);
  return new OrchestratorError(CODES.INTERNAL, messageOf(error), details);
}

/**
 * The JSON body for one failure.
 * @param error - the thrown value.
 * @param details - extra context for an unexpected failure.
 * @returns an `{ok:false, error}` envelope.
 */
export function errorBody(error, details = {}) {
  const resolved = toEnvelope(error, details);
  return {
    ok: false,
    error: {
      code: resolved.code,
      message: resolved.message,
      ...(resolved.details === undefined ? {} : { details: resolved.details }),
    },
  };
}

/**
 * Read one field from a decoded JSON body.
 * @param body - the decoded value.
 * @param key - field name.
 * @returns the value, or `undefined` when absent.
 */
export function field(body, key) {
  return body !== null && typeof body === 'object' ? body[key] : undefined;
}

/**
 * Require a non-empty string field.
 * @param body - the decoded body.
 * @param key - field name.
 * @returns the trimmed value.
 * @throws {OrchestratorError} BAD_REQUEST when absent or empty.
 */
export function requireString(body, key) {
  const value = field(body, key);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw fail(CODES.BAD_REQUEST, `${key} is required`);
  }
  return value.trim();
}

/**
 * Read an optional string field, treating blank as absent.
 * @param body - the decoded body.
 * @param key - field name.
 * @returns the trimmed value, or `undefined`.
 */
export function optionalString(body, key) {
  const value = field(body, key);
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return value.trim();
}
