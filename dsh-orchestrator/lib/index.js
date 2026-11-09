/**
 * dsh-orchestrator — a minimal, localhost-only control surface that lets an
 * external orchestrator route work to long-lived DSH sessions.
 *
 * Shape of the thing:
 *
 *   * It owns one `node:http` listener bound to a loopback address. It does not
 *     register routes on DSH's own web server, so it never has to reason about
 *     that server's browser-trust fence — which is what forced the reference
 *     implementation into a query-string bypass.
 *   * Every route requires `Authorization: Bearer <token>`, including
 *     `/v1/health`. There is no unauthenticated surface at all.
 *   * A query-string token is refused outright, so the "no query token" rule is
 *     structural rather than documentary.
 *   * Every capability is delegated to DSH's official `sessionController`,
 *     `workspaceController` and `workspaceRegistry`. This plugin holds no
 *     session state, no locks, and no session database of its own.
 *   * Its own persistence is one small file that deliberately contains no
 *     secret: `<DSH_HOME>/orchestrator/endpoint.json`.
 *
 * @module dsh-orchestrator
 */

import { createServer } from 'node:http';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CODES, errorBody, fail, httpStatus } from './errors.js';
import { resolveConfig, runGate } from './gate.js';
import * as handlers from './handlers.js';
import { parseBearer, resolveControlToken, tokenMatches } from './token.js';

/** Plugin name, also the loader row id and the credential-record scope. */
export const name = 'dsh-orchestrator';

/**
 * The session controller is the one hard dependency: without it this surface
 * cannot do anything, and its absence is also what distinguishes a profile this
 * plugin may mount in (web-app based) from one it must not (headless).
 */
export const inject = ['sessionController'];

/** Version of this plugin, mirrored into `/v1/health` and `endpoint.json`. */
const PLUGIN_VERSION = '0.2.0';

/** Largest accepted request body. Prompts are text-only, so this is generous. */
const MAX_BODY_BYTES = 1 * 1024 * 1024;

/** Bound on simultaneously open sockets, so a local flood cannot grow unbounded. */
const MAX_CONNECTIONS = 32;

/** Path of the non-secret discovery file inside the harness home. */
const ENDPOINT_DIRNAME = 'orchestrator';
const ENDPOINT_FILENAME = 'endpoint.json';

const SESSION_ROUTE = /^\/v1\/sessions\/([^/]+)\/(attach|rename|prompt|status|sandbox|cancel)$/;

/** Host header spellings accepted, so a rebinding name cannot reach us. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Require one of the allowed methods.
 * @param method - the request method.
 * @param allowed - the allowed methods.
 */
function requireMethod(method, allowed) {
  if (!allowed.includes(method)) {
    throw fail(CODES.METHOD_NOT_ALLOWED, `${method} is not allowed here; use ${allowed.join(' or ')}`, {
      allowed,
    });
  }
}

/**
 * Reject a request whose `Host` header is not a loopback spelling. Binding to
 * loopback already stops off-host traffic; this additionally stops a browser
 * that was tricked into resolving some other name to 127.0.0.1.
 * @param request - the incoming request.
 */
function requireLoopbackHost(request) {
  const raw = request.headers.host;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw fail(CODES.BAD_REQUEST, 'a Host header is required');
  }
  // Strip a trailing :port, keeping IPv6 brackets intact.
  const hostname = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    throw fail(CODES.BAD_REQUEST, `Host "${raw}" is not loopback; this surface accepts loopback Host headers only`, {
      host: raw,
    });
  }
}

/**
 * Read and decode a JSON request body.
 * @param request - the incoming request.
 * @returns the decoded value, or `undefined` when the body is empty.
 */
async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw fail(CODES.BAD_REQUEST, `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw fail(CODES.BAD_REQUEST, 'request body is not valid JSON');
  }
}

/**
 * Send one JSON response.
 * @param response - the server response.
 * @param status - the HTTP status.
 * @param payload - the JSON-serialisable body.
 */
function sendJson(response, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  response.end(body);
}

/**
 * The `/v1/health` body. Deliberately carries no token and no value derived
 * from one: a short digest would only be useful for offline verification,
 * which this localhost surface has no need for.
 * @param context - the boot context captured by {@link apply}.
 * @returns the health projection.
 */
function healthBody(context) {
  return {
    ok: true,
    service: name,
    pluginVersion: PLUGIN_VERSION,
    dshVersion: context.gate.dshVersion,
    dshVersionVia: context.gate.dshVersionVia,
    capabilities: context.gate.capabilities,
    listen: { host: context.bound.host, port: context.bound.port },
    auth: {
      scheme: 'bearer',
      header: 'authorization',
      source: context.token.source,
      // The record address, never a value or a hash of one.
      credentialKey: context.token.key,
      queryTokenAccepted: false,
    },
    startedAt: context.startedAt,
  };
}

/**
 * Dispatch one request to a handler.
 * @param request - the incoming request.
 * @param url - the parsed URL.
 * @param services - the resolved DSH services.
 * @param context - the boot context.
 * @returns the response body.
 */
async function dispatch(request, url, services, context) {
  const pathname = url.pathname;

  if (pathname === '/v1/health') {
    requireMethod(request.method, ['GET']);
    return healthBody(context);
  }

  if (pathname === '/v1/workspaces') {
    requireMethod(request.method, ['GET']);
    return handlers.listWorkspaces(services);
  }

  if (pathname === '/v1/workspaces/ensure') {
    requireMethod(request.method, ['POST']);
    return handlers.ensureWorkspace(services, await readJson(request));
  }

  if (pathname === '/v1/sessions') {
    if (request.method === 'GET') return handlers.listSessions(services, url.searchParams);
    if (request.method === 'POST') return handlers.createSession(services, await readJson(request));
    throw fail(CODES.METHOD_NOT_ALLOWED, 'use GET or POST on /v1/sessions', { allowed: ['GET', 'POST'] });
  }

  const match = SESSION_ROUTE.exec(pathname);
  if (match !== null) {
    let sessionId;
    try {
      sessionId = decodeURIComponent(match[1]);
    } catch {
      throw fail(CODES.BAD_REQUEST, 'the session id in the path is not valid percent-encoding');
    }
    if (sessionId.length === 0) throw fail(CODES.BAD_REQUEST, 'a session id is required in the path');

    const action = match[2];
    if (action === 'status') {
      requireMethod(request.method, ['GET']);
      return handlers.sessionStatus(services, sessionId, url.searchParams);
    }
    if (action === 'sandbox') {
      // Reading the standing mode is unconditional. POST is the explicit
      // switch and the only way a mode ever changes: nothing in this surface
      // escalates after a failed prompt, a denial, or an out-of-root path.
      if (request.method === 'GET') return handlers.sandboxStatus(services, sessionId);
      requireMethod(request.method, ['POST']);
      return handlers.setSandbox(services, sessionId, await readJson(request));
    }
    requireMethod(request.method, ['POST']);
    if (action === 'cancel') return handlers.cancelSession(services, sessionId);

    const body = await readJson(request);
    if (action === 'attach') return handlers.attachSession(services, sessionId, body);
    if (action === 'rename') return handlers.renameSession(services, sessionId, body);
    return handlers.promptSession(services, sessionId, body);
  }

  throw fail(CODES.NOT_FOUND, `no route for ${request.method} ${pathname}`);
}

/**
 * Write the non-secret discovery file so a client can find the actual port when
 * `port: 0` asked the OS for one.
 * @param home - the harness home.
 * @param payload - the file contents.
 * @returns the absolute path written.
 */
function writeEndpointFile(home, payload) {
  const dir = join(home, ENDPOINT_DIRNAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, ENDPOINT_FILENAME);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows has no POSIX mode bits; the file carries no secret anyway.
  }
  return file;
}

/**
 * Mount the plugin. Any failure here is deliberate and loud: a control surface
 * whose security invariants cannot be met must not come up at all.
 * @param ctx - the Cordis context.
 * @param rawConfig - the loader row's config.
 */
export function apply(ctx, rawConfig) {
  const context = { config: undefined, gate: undefined, token: undefined, bound: { host: null, port: null }, startedAt: Date.now() };

  // Fail fast and synchronously on a forbidden binding, before any async work.
  const config = resolveConfig(rawConfig);
  context.config = config;

  const log = (message) => {
    try {
      ctx.logger?.info?.(`[dsh-orchestrator] ${message}`);
    } catch {
      // Logging must never take the surface down.
    }
  };
  const warn = (error) => {
    try {
      ctx.logger?.warn?.(error);
    } catch {
      // As above.
    }
  };

  ctx.effect(() => {
    let server;
    let disposed = false;

    void (async () => {
      const gate = await runGate(ctx, config);
      context.gate = gate;

      const token = await resolveControlToken(ctx, config);
      context.token = token;

      const services = {
        sessionController: ctx.get('sessionController'),
        workspaceController: ctx.get('workspaceController'),
        workspaceRegistry: ctx.get('workspaceRegistry'),
        // Optional seams, fetched rather than injected so this plugin still
        // mounts where the sandbox package is absent. The sandbox feature
        // reports SANDBOX_UNAVAILABLE there instead of taking the surface down.
        sandboxPolicy: ctx.get('sandboxPolicy'),
        sessions: ctx.get('sessions'),
        requestTimeoutMs: config.requestTimeoutMs,
        waitTimeoutMs: config.waitTimeoutMs,
        waitTimeoutMaxMs: config.waitTimeoutMaxMs,
      };

      server = createServer((request, response) => {
        const started = Date.now();
        const finish = (status, code) => {
          log(
            `${request.method} ${request.url} -> ${status}${code === undefined ? '' : ` ${code}`} (${Date.now() - started}ms)`,
          );
        };

        void (async () => {
          let status = 200;
          let code;
          try {
            const url = new URL(request.url ?? '/', 'http://127.0.0.1');

            // Refuse a query-string token before anything else, so the rule
            // cannot be worked around by an authenticated caller either.
            if (url.searchParams.has('token') || url.searchParams.has('t')) {
              throw fail(
                CODES.TOKEN_IN_QUERY_FORBIDDEN,
                'a token in the query string is not accepted; use the Authorization: Bearer header',
              );
            }

            requireLoopbackHost(request);

            const offered = parseBearer(request.headers.authorization);
            if (!tokenMatches(offered, token.token)) {
              throw fail(CODES.UNAUTHORIZED, 'a valid Authorization: Bearer token is required');
            }

            const body = await dispatch(request, url, services, context);
            sendJson(response, 200, { ok: true, result: body });
          } catch (error) {
            const payload = errorBody(error, { method: request.method, path: request.url });
            status = httpStatus(payload.error.code);
            code = payload.error.code;
            if (payload.error.code === CODES.INTERNAL) warn(error);
            if (!response.headersSent) sendJson(response, status, payload);
            else response.end();
          } finally {
            finish(status, code);
          }
        })();
      });

      server.maxConnections = MAX_CONNECTIONS;
      server.requestTimeout = config.requestTimeoutMs;
      server.headersTimeout = config.requestTimeoutMs;
      server.on('clientError', (_error, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      });
      server.on('error', (error) => warn(error));

      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });

      const address = server.address();
      const actualPort = address !== null && typeof address === 'object' ? address.port : config.port;
      context.bound = { host: config.host, port: actualPort };

      const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
        ? process.env.DSH_HOME
        : join(homedir(), '.dsh');
      let endpointPath = null;
      try {
        endpointPath = writeEndpointFile(home, {
          service: name,
          pluginVersion: PLUGIN_VERSION,
          dshVersion: gate.dshVersion,
          host: config.host,
          port: actualPort,
          pid: process.pid,
          startedAt: context.startedAt,
        });
      } catch (error) {
        warn(error);
      }

      log(
        `listening on http://${config.host}:${actualPort} (dsh ${gate.dshVersion ?? 'unknown'}, ` +
          `token source: ${token.source}${token.key === null ? '' : ` ${token.key}`}, ` +
          `attach: ${gate.capabilities.attachProbe})`,
      );
      if (endpointPath !== null) log(`endpoint file: ${endpointPath}`);
      if (gate.capabilities.attachProbe === 'unverified') {
        log('attach capability unverified: the workspace registry is empty, so it will be checked on first use');
      }
    })().catch((error) => {
      // Runs when the gate, the token, or the bind fails.
      if (!disposed) warn(error);
    });

    return () => {
      disposed = true;
      if (server === undefined) return;
      server.close();
      server.closeAllConnections?.();
    };
  }, 'dsh-orchestrator:listen');
}
