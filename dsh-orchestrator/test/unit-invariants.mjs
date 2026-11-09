/**
 * Structural invariant tests.
 *
 * These assert properties of the source itself, because they are the promises
 * that a future edit could quietly break: no session-file access, exactly one
 * session-creation site, no DSH package imports, no off-host bind, no query
 * token, no shell.
 *
 * @module dsh-orchestrator/test/unit-invariants
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const sources = new Map(
  readdirSync(libDir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => [file, readFileSync(join(libDir, file), 'utf8')]),
);
const all = [...sources.values()].join('\n');
const sourceOf = (name) => {
  const text = sources.get(name);
  assert.ok(text !== undefined, `${name} should exist`);
  return text;
};

test('no session persistence artefact is ever named', () => {
  // These are the on-disk forms of DSH's session log and projection cache.
  assert.doesNotMatch(all, /\.jsonl/, 'the session log filename must not appear');
  assert.doesNotMatch(all, /zstd/i, 'the compression format must not appear');
  assert.doesNotMatch(all, /projcache/i, 'the projection cache must not appear');
  assert.doesNotMatch(all, /workspace\.json/, 'the workspace store must not appear');
  assert.doesNotMatch(all, /session\.v\d/, 'the versioned log filename must not appear');
});

test('the only filesystem write is the non-secret endpoint file', () => {
  const writes = all.match(/writeFileSync\(/g) ?? [];
  assert.equal(writes.length, 1, 'there is exactly one write call site');
  const index = sourceOf('index.js');
  const fn = index.slice(index.indexOf('function writeEndpointFile('), index.indexOf('export function apply('));
  assert.match(fn, /writeFileSync\(file,/, 'the single write lives inside writeEndpointFile');
});

test('the only filesystem read is the version probe', () => {
  const reads = all.match(/readFileSync\(/g) ?? [];
  assert.equal(reads.length, 1, 'there is exactly one read call site');
  assert.match(sourceOf('gate.js'), /readFileSync\(file, 'utf8'\)/, 'the single read is the package.json probe');
});

test('there is exactly one session-creation call site', () => {
  const matches = all.match(/sessionController\.create\(/g) ?? [];
  assert.equal(matches.length, 1, 'a busy session must never be worked around by creating another one');
  assert.match(
    sourceOf('handlers.js'),
    /export async function createSession/,
    'the single creation site lives in createSession',
  );
});

test('no DSH package is imported, because a profile plugin cannot resolve one', () => {
  assert.doesNotMatch(all, /from\s+'@deepseek-ai\//);
  assert.doesNotMatch(all, /import\('@deepseek-ai\//);
});

test('nothing spawns a process or evaluates code', () => {
  assert.doesNotMatch(all, /child_process/);
  assert.doesNotMatch(all, /\bexecSync\b/);
  assert.doesNotMatch(all, /\bspawnSync\b/);
  assert.doesNotMatch(all, /\beval\(/);
  assert.doesNotMatch(all, /new Function/);
});

test('no off-host bind spelling appears anywhere in the source', () => {
  assert.doesNotMatch(all, /0\.0\.0\.0/, 'the wildcard bind must not appear in code');
  assert.doesNotMatch(all, /'::'/, 'the IPv6 wildcard must not appear in code');
});

test('listen is called only with the allowlist-validated host', () => {
  const index = sourceOf('index.js');
  assert.match(index, /server\.listen\(config\.port, config\.host,/);
  const listenArgs = index.match(/\.listen\(([^)]*)\)/g) ?? [];
  assert.equal(listenArgs.length, 1, 'there is exactly one listen call');
  assert.match(listenArgs[0], /config\.host/, 'the bind host comes from the validated config');
});

test('the Host header is restricted to loopback, so rebinding cannot reach us', () => {
  const index = sourceOf('index.js');
  assert.match(index, /requireLoopbackHost\(request\)/);
  assert.match(index, /LOOPBACK_HOSTNAMES/);
});

test('a query-string token is detected and refused, never read as one', () => {
  const index = sourceOf('index.js');
  assert.match(index, /searchParams\.has\('token'\)/);
  assert.match(index, /searchParams\.has\('t'\)/);
  assert.doesNotMatch(index, /searchParams\.get\('token'\)/, 'a query token must never be read as a credential');
  assert.doesNotMatch(index, /searchParams\.get\('t'\)/);
  assert.match(index, /parseBearer\(request\.headers\.authorization\)/, 'the header is the only credential source');
});

test('every route is authenticated, including health', () => {
  const index = sourceOf('index.js');
  // The auth check precedes dispatch, so no route can be reached without it.
  const authIndex = index.indexOf('tokenMatches(offered, token.token)');
  const dispatchIndex = index.indexOf('await dispatch(request, url, services, context)');
  assert.ok(authIndex > 0 && dispatchIndex > 0 && authIndex < dispatchIndex, 'auth runs before dispatch');
  assert.doesNotMatch(index, /pathname === '\/v1\/health'[\s\S]{0,240}?tokenMatches/, 'health is not exempted');
});

test('the discovery file carries no token', () => {
  const index = sourceOf('index.js');
  const call = index.slice(index.indexOf('writeEndpointFile(home, {'));
  const payload = call.slice(0, call.indexOf('});'));
  assert.ok(payload.length > 0, 'the endpoint payload should be found');
  assert.doesNotMatch(payload, /token/i, 'endpoint.json must never carry the control token');
});

test('health exposes no value derived from the token', () => {
  const index = sourceOf('index.js');
  const health = index.slice(index.indexOf('function healthBody('), index.indexOf('async function dispatch('));
  assert.ok(health.length > 0, 'the health projection should be found');
  assert.doesNotMatch(health, /fingerprint/i);
  assert.doesNotMatch(health, /token\.token/);
  assert.doesNotMatch(health, /createHash/);
});

test('create defaults mode to queue and accepts steer only when named', () => {
  const handlers = sourceOf('handlers.js');
  assert.match(handlers, /let mode = 'queue'/);
  assert.match(handlers, /rawMode !== undefined/);
  assert.match(handlers, /mode must be "queue" or "steer"/);
});

test('create requires an explicit workspaceId or cwd', () => {
  const handlers = sourceOf('handlers.js');
  assert.match(handlers, /workspaceId or cwd is required/);
  assert.match(handlers, /pass workspaceId or cwd, not both/);
});

test('attach uses the official ownership write and never a fallback', () => {
  const handlers = sourceOf('handlers.js');
  assert.match(handlers, /workspace\.attachSession\(sessionId\)/);
  assert.doesNotMatch(handlers, /insertSessionBefore/, 'insertSessionBefore cannot account an unaccounted session');
  assert.doesNotMatch(handlers, /writeFile|readFile/, 'attach must not touch the filesystem');
});

test('status reads through list and follow, never through resolveAgent', () => {
  const handlers = sourceOf('handlers.js');
  const status = handlers.slice(handlers.indexOf('export async function sessionStatus('));
  assert.match(status, /sessionController\.follow\(/);
  assert.doesNotMatch(status, /resolveAgent/, 'a status read must never resume a cold session');
  assert.doesNotMatch(handlers, /resolveAgent/, 'nothing in this surface may resume an agent implicitly');
});

test('the loopback allowlist is the only thing that binds', () => {
  const gate = sourceOf('gate.js');
  assert.match(gate, /const LOOPBACK_HOSTS = Object\.freeze\(\{/);
  assert.match(gate, /refusing to bind/);
});

test('the tested-version set, the peer range, and engines.dsh agree', () => {
  const gate = sourceOf('gate.js');
  const match = /TESTED_DSH_VERSIONS = Object\.freeze\(\[([^\]]*)\]\)/.exec(gate);
  assert.ok(match !== null, 'TESTED_DSH_VERSIONS must be a frozen literal array');
  const tested = [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
  assert.deepEqual(tested, ['0.2.0-rc.2', '0.2.1-rc.2']);

  // Three places must name the same versions: the runtime gate, the slot npm
  // reads (peerDependencies, the only one 0.2.0-rc.2 evaluates), and the slot
  // 0.2.1-rc.2 prefers (engines.dsh). Adding a version to one and not the others
  // either blocks installation or silently runs untested.
  const manifest = JSON.parse(readFileSync(join(libDir, '..', 'package.json'), 'utf8'));
  const peer = manifest.peerDependencies['@deepseek-ai/dsh'];
  const engine = manifest.engines.dsh;
  for (const version of tested) {
    assert.ok(peer.includes(version), `peerDependencies must allow ${version}`);
    assert.ok(engine.includes(version), `engines.dsh must allow ${version}`);
  }
});

test('the reported plugin version cannot drift from package.json', () => {
  // `PLUGIN_VERSION` is what `/v1/health` and `endpoint.json` publish, so a bump
  // that forgets it makes the surface report a version that does not exist. That
  // is exactly the kind of drift a reviewer cannot see in a diff of lib/ alone.
  const index = sourceOf('index.js');
  const match = /const PLUGIN_VERSION = '([^']+)'/.exec(index);
  assert.ok(match !== null, 'PLUGIN_VERSION must be a string literal');
  const manifest = JSON.parse(readFileSync(join(libDir, '..', 'package.json'), 'utf8'));
  assert.equal(match[1], manifest.version, 'PLUGIN_VERSION must equal package.json version');
});
