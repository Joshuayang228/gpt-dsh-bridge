/**
 * Tests for the Runtime Contract injection in tools/dsho.ps1.
 *
 * The contract lives in exactly one place — the marked block in
 * agent-skills/dsh-handoff.md — and the script only locates, extracts, validates
 * and appends it. `-DryRun` composes the payload and prints it instead of
 * sending, which is what makes these tests runnable without a live DSH host.
 *
 * Two properties are load-bearing and pinned below:
 *   - `-DryRun` must not need a host, an endpoint file or a credential.
 *   - `-ContractFile` must be rejected on any real dispatch, so the canonical
 *     handoff file stays the only source of truth.
 *
 * If PowerShell cannot actually run (for example a blocked sandbox), these tests
 * FAIL rather than skip. A skipped injection test would report success while the
 * behaviour stayed unverified, which is exactly what this project forbids.
 *
 * Assertions use ASCII tokens on purpose. The contract itself is Chinese, and a
 * console code page mismatch could otherwise turn a passing case into a decoding
 * failure; `GPT Review` appears once in the contract and nowhere else, so
 * counting it proves "appended exactly once" without depending on encoding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const scriptPath = join(repoRoot, 'tools', 'dsho.ps1');
const handoffPath = join(repoRoot, 'agent-skills', 'dsh-handoff.md');
const scriptSource = readFileSync(scriptPath, 'utf8');
const handoffSource = readFileSync(handoffPath, 'utf8');

/**
 * Find a PowerShell that can actually execute something.
 * Records every candidate so a failure can say WHY it could not run.
 */
function discoverShells() {
  const seen = [];
  for (const candidate of ['pwsh', 'powershell.exe']) {
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' });
    if (probe.error !== undefined && probe.error.code === 'ENOENT') continue;
    const detail = `${probe.stderr ?? ''}${probe.error?.message ?? ''}`.trim().split('\n')[0] ?? '';
    seen.push({ candidate, ok: probe.status === 0, detail });
  }
  return seen;
}

const shells = discoverShells();
const usableShell = shells.find((entry) => entry.ok)?.candidate;

/** Returns a runnable PowerShell, or fails loudly with the reason it is not. */
function requireShell() {
  if (usableShell !== undefined) return usableShell;
  const reason =
    shells.length === 0
      ? 'no PowerShell executable on PATH'
      : shells.map((entry) => `${entry.candidate}: ${entry.detail}`).join(' | ');
  assert.fail(`cannot verify contract injection — PowerShell is unusable (${reason})`);
}

function runPrompt(args) {
  return spawnSync(requireShell(), ['-NoProfile', '-File', scriptPath, 'prompt', ...args], {
    encoding: 'utf8',
    cwd: repoRoot,
  });
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsho-contract-'));
}

function tempContract(name, body) {
  const file = join(tempDir(), name);
  writeFileSync(file, body, 'utf8');
  return file;
}

const countOf = (haystack, needle) => haystack.split(needle).length - 1;
// PowerShell may wrap a long script-path error in the middle of a word.
// Ignore whitespace only in error-message assertions, never in JSON payloads.
const diagnostic = (run) => `${run.stdout}${run.stderr}`.replace(/\s+/g, '');

// ------------------------------------------------------------ static contract

test('the handoff file carries exactly one marked contract block', () => {
  assert.equal(countOf(handoffSource, '<!-- RUNTIME-CONTRACT:START -->'), 1, 'exactly one START marker');
  assert.equal(countOf(handoffSource, '<!-- RUNTIME-CONTRACT:END -->'), 1, 'exactly one END marker');
  const startAt = handoffSource.indexOf('<!-- RUNTIME-CONTRACT:START -->');
  const endAt = handoffSource.indexOf('<!-- RUNTIME-CONTRACT:END -->');
  assert.ok(startAt < endAt, 'START must precede END');
  const body = handoffSource.slice(startAt, endAt);
  assert.ok(body.includes('GPT Review'), 'the block must state who reads the report');
  assert.ok(body.trim().length > 0, 'the block must not be empty');
});

test('the contract body is not duplicated in the script', () => {
  // A distinctive sentence from the contract. If it ever appears in the script,
  // someone copied the body and the two copies will drift.
  assert.ok(handoffSource.includes('最终回复固定五块'), 'the handoff file must carry the contract block');
  assert.equal(scriptSource.includes('最终回复固定五块'), false, 'tools/dsho.ps1 must not inline the contract body');
});

test('no path can append the contract twice, and only prompt appends it', () => {
  const sites = [...scriptSource.matchAll(/Add-RuntimeContract -Content/g)].map((match) => match.index);
  assert.equal(sites.length, 2, 'one site for the dry-run path and one for the real dispatch');
  const promptAt = scriptSource.indexOf("'prompt' {");
  assert.ok(promptAt > 0, 'the prompt branch must exist');
  assert.ok(sites[1] > promptAt, 'the dispatch site must live inside the prompt branch');
  // The dry-run site has to leave before the switch is reached, so the two sites
  // can never both run for one invocation.
  const between = scriptSource.slice(sites[0], promptAt);
  assert.match(between, /exit 0/, 'the dry-run path must exit before reaching the dispatch');
});

test('the default contract source is the canonical handoff file', () => {
  // No other default path may exist; -ContractFile is an override, not a second
  // source, and it is rejected outside -DryRun (asserted below).
  assert.equal(countOf(scriptSource, "'dsh-handoff.md'"), 1, 'the canonical file must be named once');
  assert.match(scriptSource, /agent-skills'\)\s*'dsh-handoff\.md'/, 'the default must resolve under agent-skills');
});

// ---------------------------------------------------- dry run without a host

test('-DryRun composes without any endpoint file (no host, no credential)', () => {
  // A fresh DshHome has no orchestrator/endpoint.json. If -DryRun still touched
  // discovery, this would fail; that is the regression this pins.
  const emptyHome = tempDir();
  const run = runPrompt(['-Session', 's', '-Text', 'run the tests', '-DshHome', emptyHome, '-DryRun']);
  assert.equal(run.status, 0, `dry run must not need a host: ${run.stderr}`);
  assert.match(run.stdout, /run the tests/, 'the task text must survive');
  assert.equal(countOf(run.stdout, 'GPT Review'), 1, 'the contract must be appended exactly once');
});

test('-TextFile composes without any endpoint file', () => {
  const emptyHome = tempDir();
  const taskFile = tempContract('task.md', 'investigate the failing test');
  const run = runPrompt(['-Session', 's', '-TextFile', taskFile, '-DshHome', emptyHome, '-DryRun']);
  assert.equal(run.status, 0, `dry run must not need a host: ${run.stderr}`);
  assert.match(run.stdout, /investigate the failing test/, 'the task text must survive');
  assert.equal(countOf(run.stdout, 'GPT Review'), 1, 'the contract must be appended exactly once');
});

test('-DryRun reads the canonical contract by default', () => {
  const emptyHome = tempDir();
  const run = runPrompt(['-Session', 's', '-Text', 'x', '-DshHome', emptyHome, '-DryRun']);
  assert.equal(run.status, 0, run.stderr);
  // A phrase that exists only inside the canonical marked block.
  assert.match(run.stdout, /当前任务若明确规定其他输出格式/, 'the canonical contract body must be the one appended');
});

// ------------------------------------------------- -ContractFile is capped

test('a real prompt rejects -ContractFile before any send', () => {
  // Still no endpoint: the guard must fire before discovery, so the message is
  // about -ContractFile rather than about a missing endpoint.
  const emptyHome = tempDir();
  const file = tempContract('task.md', 'x');
  const run = runPrompt(['-Session', 's', '-Text', 'x', '-ContractFile', file, '-DshHome', emptyHome]);
  assert.notEqual(run.status, 0, 'a real dispatch must not accept -ContractFile');
  assert.match(diagnostic(run), /-ContractFileisonlyallowedwith-DryRun/);
});

// ------------------------------------------------------------- failure modes

test('a missing contract file fails before sending', () => {
  const missing = join(tempDir(), 'absent.md');
  const run = runPrompt(['-Session', 's', '-Text', 'x', '-ContractFile', missing, '-DryRun']);
  assert.notEqual(run.status, 0, 'a missing contract must not be silently skipped');
  assert.match(diagnostic(run), /filenotfound/);
});

test('missing markers fail before sending', () => {
  const file = tempContract('nomarks.md', '# nothing marked here\n');
  const run = runPrompt(['-Session', 's', '-Text', 'x', '-ContractFile', file, '-DryRun']);
  assert.notEqual(run.status, 0);
  assert.match(diagnostic(run), /exactlyoneSTART/);
});

test('duplicate markers fail before sending', () => {
  const body = [
    '<!-- RUNTIME-CONTRACT:START -->',
    '- one',
    '<!-- RUNTIME-CONTRACT:END -->',
    '<!-- RUNTIME-CONTRACT:START -->',
    '- two',
    '<!-- RUNTIME-CONTRACT:END -->',
  ].join('\n');
  const file = tempContract('dupe.md', body);
  const run = runPrompt(['-Session', 's', '-Text', 'x', '-ContractFile', file, '-DryRun']);
  assert.notEqual(run.status, 0);
  assert.match(diagnostic(run), /exactlyoneSTART/);
});

test('an empty contract body fails before sending', () => {
  const body = '<!-- RUNTIME-CONTRACT:START -->\n   \n<!-- RUNTIME-CONTRACT:END -->\n';
  const file = tempContract('empty.md', body);
  const run = runPrompt(['-Session', 's', '-Text', 'x', '-ContractFile', file, '-DryRun']);
  assert.notEqual(run.status, 0);
  assert.match(diagnostic(run), /empty/);
});

test('markers in the wrong order fail before sending', () => {
  const body = ['<!-- RUNTIME-CONTRACT:END -->', '- reversed', '<!-- RUNTIME-CONTRACT:START -->'].join('\n');
  const file = tempContract('reversed.md', body);
  const run = runPrompt(['-Session', 's', '-Text', 'x', '-ContractFile', file, '-DryRun']);
  assert.notEqual(run.status, 0);
  assert.match(diagnostic(run), /beforeSTART/);
});
