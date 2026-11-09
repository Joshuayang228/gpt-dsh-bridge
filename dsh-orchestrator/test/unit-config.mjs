/**
 * Configuration, capability-probe and gate tests. Pure: no DSH, no install.
 *
 * `resolveConfig` is the first thing that runs and the only thing standing
 * between a loader patch and a wildcard bind, so it gets its own file.
 *
 * @module dsh-orchestrator/test/unit-config
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CODES } from '../lib/errors.js';
import { TESTED_DSH_VERSIONS, probeCapabilities, resolveConfig, runGate } from '../lib/gate.js';

/** A context exposing exactly the services named. */
function fakeCtx(services) {
  return { get: (name) => services[name] };
}

/** Every method the gate requires, so a "healthy" fake can be built. */
function healthyServices() {
  const methods = (names) => Object.fromEntries(names.map((name) => [name, () => {}]));
  return {
    sessionController: methods(['list', 'create', 'rename', 'prompt', 'cancel', 'follow']),
    workspaceController: methods(['create']),
    workspaceRegistry: {
      ...methods(['get', 'list']),
      archivedSessionIds: [],
      list: () => [{ attachSession: () => {} }],
    },
    credentials: methods(['readRecord', 'modifyRecord']),
  };
}

test('the tested DSH version set holds the installed release', () => {
  assert.ok(TESTED_DSH_VERSIONS.includes('0.2.0-rc.2'));
});

test('loopback spellings are accepted and normalised to 127.0.0.1', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    assert.equal(resolveConfig({ host }).host, '127.0.0.1', `${host} should be accepted`);
  }
});

test('the default host is loopback', () => {
  assert.equal(resolveConfig({}).host, '127.0.0.1');
  assert.equal(resolveConfig(undefined).host, '127.0.0.1');
});

test('every off-host spelling is refused', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.1', 'example.com', '*', '']) {
    assert.throws(
      () => resolveConfig({ host }),
      (error) => error.code === CODES.GATE_FAILED && /refusing to bind/.test(error.message),
      `${JSON.stringify(host)} must be refused`,
    );
  }
});

test('a non-string host is refused', () => {
  assert.throws(() => resolveConfig({ host: 0 }), (error) => error.code === CODES.GATE_FAILED);
  assert.throws(() => resolveConfig({ host: null }), (error) => error.code === CODES.GATE_FAILED);
});

test('the port defaults to 0 so the OS picks a free loopback port', () => {
  assert.equal(resolveConfig({}).port, 0);
  assert.equal(resolveConfig({ port: 0 }).port, 0);
  assert.equal(resolveConfig({ port: 7733 }).port, 7733);
  assert.equal(resolveConfig({ port: 65535 }).port, 65535);
});

test('an out-of-range or non-integer port is refused', () => {
  for (const port of [-1, 65536, 1.5, '7733', null, Number.NaN]) {
    assert.throws(() => resolveConfig({ port }), (error) => error.code === CODES.GATE_FAILED, `port ${String(port)}`);
  }
});

test('a non-boolean allowUntestedVersion is refused', () => {
  assert.throws(() => resolveConfig({ allowUntestedVersion: 'yes' }), (error) => error.code === CODES.GATE_FAILED);
  assert.equal(resolveConfig({ allowUntestedVersion: true }).allowUntestedVersion, true);
  assert.equal(resolveConfig({}).allowUntestedVersion, false);
});

test('timeouts are clamped, and the wait budget respects its ceiling', () => {
  const wide = resolveConfig({ waitTimeoutMaxMs: 9_999_999, waitTimeoutMs: 9_999_999, requestTimeoutMs: 9_999_999 });
  assert.equal(wide.waitTimeoutMaxMs, 3_600_000);
  assert.equal(wide.waitTimeoutMs, 3_600_000);
  assert.equal(wide.requestTimeoutMs, 300_000);

  const narrow = resolveConfig({ waitTimeoutMaxMs: 1, waitTimeoutMs: 1, requestTimeoutMs: 1 });
  assert.equal(narrow.waitTimeoutMaxMs, 10_000);
  assert.equal(narrow.waitTimeoutMs, 1_000);
  assert.equal(narrow.requestTimeoutMs, 1_000);

  // The wait budget can never exceed its own ceiling.
  const capped = resolveConfig({ waitTimeoutMaxMs: 20_000, waitTimeoutMs: 500_000 });
  assert.equal(capped.waitTimeoutMs, 20_000);

  assert.equal(resolveConfig({ waitTimeoutMs: 'lots' }).waitTimeoutMs, 120_000);
});

test('a blank pinned token is treated as absent', () => {
  assert.equal(resolveConfig({ token: '' }).token, undefined);
  assert.equal(resolveConfig({ token: 'x'.repeat(32) }).token, 'x'.repeat(32));
});

test('a healthy host passes the capability probe', () => {
  const report = probeCapabilities(fakeCtx(healthyServices()));
  assert.equal(report.ok, true, report.missing.join('; '));
  assert.deepEqual(report.missing, []);
  assert.equal(report.attachProbe, 'present');
});

test('a missing service is reported by name', () => {
  const services = healthyServices();
  delete services.workspaceRegistry;
  const report = probeCapabilities(fakeCtx(services));
  assert.equal(report.ok, false);
  assert.ok(report.missing.some((entry) => /workspaceRegistry is not composed/.test(entry)), report.missing.join('; '));
});

test('a missing method is reported precisely', () => {
  const services = healthyServices();
  delete services.sessionController.follow;
  const report = probeCapabilities(fakeCtx(services));
  assert.equal(report.ok, false);
  assert.ok(report.missing.includes('sessionController.follow is missing'));
});

test('a missing archivedSessionIds accessor is reported', () => {
  const services = healthyServices();
  delete services.workspaceRegistry.archivedSessionIds;
  const report = probeCapabilities(fakeCtx(services));
  assert.ok(report.missing.includes('workspaceRegistry.archivedSessionIds is missing'));
});

test('an entity without attachSession fails the probe', () => {
  const services = healthyServices();
  services.workspaceRegistry.list = () => [{}];
  const report = probeCapabilities(fakeCtx(services));
  assert.equal(report.attachProbe, 'missing');
  assert.ok(report.missing.includes('Workspace.attachSession is missing'));
});

test('an empty registry leaves attach unverified rather than failing', () => {
  const services = healthyServices();
  services.workspaceRegistry.list = () => [];
  const report = probeCapabilities(fakeCtx(services));
  assert.equal(report.ok, true);
  assert.equal(report.attachProbe, 'unverified');
});

test('an unreadable registry leaves attach unavailable rather than failing', () => {
  const services = healthyServices();
  delete services.workspaceRegistry.list;
  const report = probeCapabilities(fakeCtx(services));
  // `list` is required, so this is also reported as a missing method.
  assert.equal(report.attachProbe, 'unavailable');
  assert.ok(report.missing.includes('workspaceRegistry.list is missing'));
});

test('the gate refuses to start when the version cannot be determined', async () => {
  const config = resolveConfig({});
  // A context with no profileContext and no DSH_PACKAGE_ROOT: the probe falls
  // through to require.resolve, which cannot see the global install from here.
  await assert.rejects(
    runGate(fakeCtx(healthyServices()), config),
    (error) => error.code === CODES.GATE_FAILED && /allowUntestedVersion/.test(error.message),
  );
});

test('the gate proceeds on an undetermined version only when explicitly allowed', async () => {
  const config = resolveConfig({ allowUntestedVersion: true });
  const gate = await runGate(fakeCtx(healthyServices()), config);
  assert.equal(gate.capabilities.ok, true);
});

test('a capability failure is reported even when the version is allowed', async () => {
  const services = healthyServices();
  delete services.sessionController.prompt;
  const config = resolveConfig({ allowUntestedVersion: true });
  await assert.rejects(
    runGate(fakeCtx(services), config),
    (error) => error.code === CODES.GATE_FAILED && error.details.problems.includes('sessionController.prompt is missing'),
  );
});
