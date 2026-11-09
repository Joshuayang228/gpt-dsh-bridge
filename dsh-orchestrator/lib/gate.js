/**
 * Configuration validation, the loopback allowlist, and the startup
 * capability/version gate.
 *
 * The gate is deliberately fail-loud: every problem it finds is collected and
 * thrown as one `GATE_FAILED`, which DSH's startup audit surfaces. A control
 * surface that silently degrades because a service is missing is worse than one
 * that refuses to start, because the orchestrator cannot tell the difference
 * between "no sessions" and "broken plumbing".
 *
 * @module dsh-orchestrator/gate
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODES, fail } from './errors.js';

/** Loopback spellings accepted for `config.host`. Nothing else starts. */
const LOOPBACK_HOSTS = Object.freeze({
  '127.0.0.1': '127.0.0.1',
  '::1': '127.0.0.1',
  localhost: '127.0.0.1',
});

/** DSH versions this build was verified against. */
export const TESTED_DSH_VERSIONS = Object.freeze(['0.2.0-rc.2', '0.2.1-rc.2']);

/**
 * Methods this surface needs on each official service. Kept in step with the
 * actual call sites in `handlers.js`: the gate must not demand a capability the
 * code never uses, nor omit one it does.
 */
const REQUIRED_METHODS = Object.freeze({
  sessionController: ['list', 'create', 'rename', 'prompt', 'cancel', 'follow'],
  // `workspace.list` reads the registry directly (synchronous, no stream), so
  // only `create` is needed on the controller.
  workspaceController: ['create'],
  workspaceRegistry: ['get', 'list'],
  credentials: ['readRecord', 'modifyRecord'],
});

/** Accessors the gate requires, checked for presence rather than callability. */
const REQUIRED_PROPERTIES = Object.freeze({
  workspaceRegistry: ['archivedSessionIds'],
});

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_TIMEOUT_MAX_MS = 600_000;

/**
 * Clamp one numeric config field.
 * @param value - the raw value.
 * @param fallback - used when the value is not a finite number.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the clamped integer.
 */
function clampInt(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  if (!Number.isInteger(rounded)) return fallback;
  return Math.min(Math.max(rounded, min), max);
}

/**
 * Validate and normalize the plugin config. Runs before anything else, so a
 * forbidden binding or a malformed timeout can never reach `listen`.
 * @param raw - the raw config from the loader patch.
 * @returns the resolved config.
 * @throws {OrchestratorError} GATE_FAILED on any invalid field.
 */
export function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {};

  const hostInput = config.host === undefined ? '127.0.0.1' : config.host;
  if (typeof hostInput !== 'string' || !Object.hasOwn(LOOPBACK_HOSTS, hostInput)) {
    throw fail(
      CODES.GATE_FAILED,
      `config.host must be one of ${Object.keys(LOOPBACK_HOSTS).join(', ')}; refusing to bind "${String(hostInput)}"`,
      { host: String(hostInput), allowed: Object.keys(LOOPBACK_HOSTS) },
    );
  }

  const portInput = config.port === undefined ? 0 : config.port;
  if (typeof portInput !== 'number' || !Number.isInteger(portInput) || portInput < 0 || portInput > 65535) {
    throw fail(CODES.GATE_FAILED, 'config.port must be an integer in 0..65535 (0 asks the OS for a free port)', {
      port: portInput,
    });
  }

  if (config.allowUntestedVersion !== undefined && typeof config.allowUntestedVersion !== 'boolean') {
    throw fail(CODES.GATE_FAILED, 'config.allowUntestedVersion must be a boolean');
  }

  const waitTimeoutMaxMs = clampInt(config.waitTimeoutMaxMs, DEFAULT_WAIT_TIMEOUT_MAX_MS, 10_000, 3_600_000);
  const waitTimeoutMs = clampInt(config.waitTimeoutMs, DEFAULT_WAIT_TIMEOUT_MS, 1_000, waitTimeoutMaxMs);
  const requestTimeoutMs = clampInt(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1_000, 300_000);

  return {
    host: LOOPBACK_HOSTS[hostInput],
    port: portInput,
    allowUntestedVersion: config.allowUntestedVersion === true,
    waitTimeoutMs,
    waitTimeoutMaxMs,
    requestTimeoutMs,
    token: typeof config.token === 'string' && config.token.length > 0 ? config.token : undefined,
  };
}

/**
 * Read a service without declaring it in `inject`, so one absent optional
 * service costs a precise gate failure instead of the plugin never mounting.
 * @param ctx - the Cordis context.
 * @param name - the service key.
 * @returns the service, or `undefined`.
 */
function service(ctx, name) {
  if (typeof ctx?.get !== 'function') return undefined;
  const found = ctx.get(name);
  return found === undefined ? undefined : found;
}

/**
 * Probe every service and method this surface needs, plus the one capability
 * that only exists on a live registry entity.
 * @param ctx - the Cordis context.
 * @returns the capability report.
 */
export function probeCapabilities(ctx) {
  const missing = [];
  const presence = {};

  for (const [name, methods] of Object.entries(REQUIRED_METHODS)) {
    const found = service(ctx, name);
    presence[name] = found !== undefined && found !== null;
    if (!presence[name]) {
      missing.push(`${name} is not composed in this Host`);
      continue;
    }
    for (const method of methods) {
      if (typeof found[method] !== 'function') missing.push(`${name}.${method} is missing`);
    }
  }

  for (const [name, properties] of Object.entries(REQUIRED_PROPERTIES)) {
    const found = service(ctx, name);
    if (found === undefined || found === null) continue; // already reported above
    for (const property of properties) {
      if (!(property in found)) missing.push(`${name}.${property} is missing`);
    }
  }

  // `WorkspaceEntity.attachSession` is the whole point of the attach endpoint,
  // and it lives on a registry entity rather than the registry service. Probe
  // it off a real entry; an empty registry leaves it unverified, and the call
  // path then reports WORKSPACE_ATTACH_UNSUPPORTED rather than pretending.
  let attachProbe = 'unverified';
  const registry = service(ctx, 'workspaceRegistry');
  if (registry !== undefined && typeof registry.list === 'function') {
    const entries = registry.list();
    if (Array.isArray(entries) && entries.length > 0) {
      attachProbe = typeof entries[0]?.attachSession === 'function' ? 'present' : 'missing';
      if (attachProbe === 'missing') missing.push('Workspace.attachSession is missing');
    }
  } else {
    attachProbe = 'unavailable';
  }

  // The sandbox surface is optional by design: this plugin must still mount in
  // a composition that omits the policy package, so an absent service is
  // reported here rather than failing the gate. `writable` additionally needs
  // `ctx.sessions`, because the mode switch is an append to a live session log
  // and that store is the only source of a live handle.
  const policy = service(ctx, 'sandboxPolicy');
  const sessions = service(ctx, 'sessions');
  const policyPresent = policy !== undefined && policy !== null;
  const sandbox = {
    available: policyPresent,
    readable: policyPresent && (typeof policy.resolve === 'function' || 'defaultMode' in policy),
    writable: policyPresent && sessions !== undefined && sessions !== null && typeof sessions.get === 'function',
    defaultMode: typeof policy?.defaultMode === 'string' ? policy.defaultMode : null,
    workspaceRoot: typeof policy?.workspaceRoot === 'string' ? policy.workspaceRoot : null,
    // Mirrors SANDBOX_MODES in @deepseek-ai/dsh-sandbox-policy. Importing that
    // package is not allowed from an installed plugin, so a drift would surface
    // as an upstream rejection of the switch rather than a silent mismatch.
    modes: ['read-only', 'workspace-write', 'danger-full-access'],
  };

  return { ok: missing.length === 0, missing, presence, attachProbe, sandbox };
}

/**
 * Best-effort DSH version probe. A plugin cannot import `@deepseek-ai/*` from
 * the global install, so the version is read off disk through a chain of
 * candidate anchors, each tried against several relative layouts.
 * @param ctx - the Cordis context.
 * @returns `{version, via}`; `version` is `undefined` when nothing resolved.
 */
export async function probeDshVersion(ctx) {
  const profileContext = service(ctx, 'profileContext');
  const anchors = [];
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && !anchors.includes(value)) anchors.push(value);
  };
  push(profileContext?.resolution?.installAnchor);
  push(profileContext?.installAnchor);
  push(process.env.DSH_PACKAGE_ROOT);

  const require_ = createRequire(import.meta.url);
  const resolved = (() => {
    try {
      return require_.resolve('@deepseek-ai/dsh/package.json');
    } catch {
      return undefined;
    }
  })();

  const candidates = [];
  for (const anchor of anchors) {
    const base = anchor.startsWith('file://') ? fileURLToPath(anchor) : anchor;
    if (!isAbsolute(base)) continue;
    candidates.push(
      [base, `${base} directly`],
      [join(base, 'package.json'), `${base}/package.json`],
      [join(base, 'dsh', 'package.json'), `${base}/dsh/package.json`],
      [join(base, '@deepseek-ai', 'dsh', 'package.json'), `${base}/@deepseek-ai/dsh/package.json`],
      [
        join(base, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
        `${base}/node_modules/@deepseek-ai/dsh/package.json`,
      ],
    );
  }
  if (resolved !== undefined) candidates.push([resolved, 'require.resolve(@deepseek-ai/dsh/package.json)']);

  for (const [file, via] of candidates) {
    if (typeof file !== 'string' || !file.endsWith('package.json')) continue;
    if (!existsSync(file)) continue;
    try {
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      if (manifest?.name === '@deepseek-ai/dsh' && typeof manifest.version === 'string' && manifest.version.length > 0) {
        return { version: manifest.version, via };
      }
    } catch {
      // An unreadable candidate is simply not the answer.
    }
  }
  return { version: undefined, via: 'unresolved' };
}

/**
 * Run the full gate. Throws one aggregated `GATE_FAILED` listing every problem.
 * @param ctx - the Cordis context.
 * @param config - the resolved config.
 * @returns `{capabilities, dshVersion, dshVersionVia}`.
 * @throws {OrchestratorError} GATE_FAILED when the host cannot be trusted.
 */
export async function runGate(ctx, config) {
  const capabilities = probeCapabilities(ctx);
  const version = await probeDshVersion(ctx);
  const problems = [...capabilities.missing];

  if (version.version === undefined) {
    if (!config.allowUntestedVersion) {
      problems.push(
        `the DSH version could not be determined (${version.via}); set allowUntestedVersion: true to run anyway`,
      );
    }
  } else if (!TESTED_DSH_VERSIONS.includes(version.version)) {
    if (!config.allowUntestedVersion) {
      problems.push(
        `DSH ${version.version} is not in the tested set [${TESTED_DSH_VERSIONS.join(', ')}]; set allowUntestedVersion: true to run anyway`,
      );
    }
  }

  if (problems.length > 0) {
    throw fail(CODES.GATE_FAILED, `dsh-orchestrator refused to start: ${problems.join('; ')}`, {
      problems,
      capabilities,
      dshVersion: version.version ?? null,
      dshVersionVia: version.via,
    });
  }

  return { capabilities, dshVersion: version.version ?? null, dshVersionVia: version.via };
}
