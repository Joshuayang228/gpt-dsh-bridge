/** Client-only tests: the GPT reminder never enters DSH's report or prompt. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', '..', 'tools', 'dsho.ps1');
const shell = ['pwsh', 'powershell.exe'].find(name =>
  spawnSync(name, ['-NoProfile', '-Command', 'exit 0']).status === 0,
);
assert.ok(shell, 'a working PowerShell is needed to test the actual client');

function run(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(shell, ['-NoProfile', '-File', script, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function withMock(reply, callback) {
  const srv = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(reply));
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const home = mkdtempSync(join(tmpdir(), 'dsho-gpt-reminder-'));
  mkdirSync(join(home, 'orchestrator'));
  writeFileSync(join(home, 'orchestrator', 'endpoint.json'), JSON.stringify({
    host: '127.0.0.1',
    port: srv.address().port,
  }), 'utf8');
  try {
    await callback(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
    await new Promise((resolve, reject) => srv.close(error => error ? reject(error) : resolve()));
  }
}

const settled = {
  ok: true,
  result: {
    sessionId: 'session-test',
    running: false,
    waitOutcome: 'idle',
    lastTurn: { seq: 42, reason: { kind: 'completed' }, text: 'result ok' },
  },
};

test('settled result carries a separate GPT reminder without modifying DSH result', async () => {
  await withMock(settled, async home => {
    const out = await run(['status', '-Session', 'session-test', '-Wait', '-DshHome', home, '-Token', 'testonly']);
    assert.equal(out.code, 0, out.stderr);
    const data = JSON.parse(out.stdout);
    assert.deepEqual(data.result, settled.result);
    assert.match(data.gptReviewReminder, /dsh-handoff\.md/);
    assert.match(data.gptReviewReminder, /过度微操/);
    assert.match(data.gptReviewReminder, /如果本会话已读取且规范未变化/);
  });
});

test('already-idle with a final turn also carries reminder', async () => {
  await withMock({ ok: true, result: { ...settled.result, waitOutcome: 'already-idle' } }, async home => {
    const out = await run(['status', '-Session', 'session-test', '-Wait', '-DshHome', home, '-Token', 'testonly']);
    assert.equal(out.code, 0, out.stderr);
    assert.ok(JSON.parse(out.stdout).gptReviewReminder);
  });
});

for (const [name, result, wait] of [
  ['non-wait status', settled.result, false],
  ['timeout', { ...settled.result, waitOutcome: 'timeout', running: true }, true],
  ['stream-ended', { ...settled.result, waitOutcome: 'stream-ended', running: true }, true],
  ['still running', { ...settled.result, running: true }, true],
  ['no completed turn', { ...settled.result, lastTurn: { text: 'partial', reason: null } }, true],
]) {
  test(name + ' does not add reminder', async () => {
    await withMock({ ok: true, result }, async home => {
      const args = ['status', '-Session', 'session-test', '-DshHome', home, '-Token', 'testonly'];
      if (wait) args.push('-Wait');
      const out = await run(args);
      assert.equal(out.code, 0, out.stderr);
      const data = JSON.parse(out.stdout);
      assert.equal(data.gptReviewReminder, undefined);
      assert.equal(data.gptReviewReminderError, undefined);
    });
  });
}

test('non-status commands keep their original envelope', async () => {
  await withMock({ ok: true, result: { service: 'dsh-orchestrator' } }, async home => {
    const out = await run(['health', '-DshHome', home, '-Token', 'testonly']);
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), { ok: true, result: { service: 'dsh-orchestrator' } });
  });
});

test('failed status keeps the error, without a reminder', async () => {
  await withMock({ ok: false, error: { code: 'SESSION_NOT_FOUND', message: 'not found' } }, async home => {
    const out = await run(['status', '-Session', 'missing', '-Wait', '-DshHome', home, '-Token', 'testonly']);
    assert.equal(out.code, 1, out.stderr);
    const data = JSON.parse(out.stdout);
    assert.equal(data.error.code, 'SESSION_NOT_FOUND');
    assert.equal(data.gptReviewReminder, undefined);
  });
});
