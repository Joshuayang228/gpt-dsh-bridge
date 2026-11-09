/**
 * Naming and projection tests. Pure: no DSH, no install, no network.
 *
 * The 80-byte case matters because the title is the routing key. DSH would
 * truncate silently; this surface refuses instead, so two long workstreams can
 * never collapse onto one title.
 *
 * @module dsh-orchestrator/test/unit-naming
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CODES } from '../lib/errors.js';
import {
  MAX_TITLE_BYTES,
  TITLE_PREFIX,
  foldLastTurn,
  normalizeWorkstream,
  textOf,
  titleForWorkstream,
  turnReason,
} from '../lib/handlers.js';

test('a workstream becomes GPT-<workstream>', () => {
  assert.equal(titleForWorkstream('四线下半链集成'), 'GPT-四线下半链集成');
});

test('a redundant GPT- prefix is not doubled', () => {
  assert.equal(titleForWorkstream('GPT-取件模块接入'), 'GPT-取件模块接入');
  assert.equal(titleForWorkstream('GPT-GPT-x'), 'GPT-x');
});

test('whitespace collapses and terminal controls are stripped', () => {
  assert.equal(normalizeWorkstream('  a \n\t b  '), 'a b');
  assert.equal(normalizeWorkstream('a\u001b[31mb\u200bc'), 'a[31mbc');
  assert.equal(normalizeWorkstream('\u202Eevil'), 'evil');
});

test('a workstream with nothing visible is refused', () => {
  assert.throws(() => normalizeWorkstream('   '), (error) => error.code === CODES.TITLE_INVALID);
  assert.throws(() => normalizeWorkstream('\u200b\u200b'), (error) => error.code === CODES.TITLE_INVALID);
});

test('an ASCII workstream at the byte boundary is accepted', () => {
  const body = 'x'.repeat(MAX_TITLE_BYTES - TITLE_PREFIX.length);
  const title = titleForWorkstream(body);
  assert.equal(Buffer.byteLength(title, 'utf8'), MAX_TITLE_BYTES);
});

test('one ASCII byte over the boundary is refused, not truncated', () => {
  const body = 'x'.repeat(MAX_TITLE_BYTES - TITLE_PREFIX.length + 1);
  assert.throws(
    () => titleForWorkstream(body),
    (error) => error.code === CODES.TITLE_INVALID && error.details.maxBytes === MAX_TITLE_BYTES,
  );
});

test('CJK is measured in bytes, not characters', () => {
  // '小' is 3 UTF-8 bytes, so 25 fit inside the 76-byte workstream allowance and
  // 26 do not, even though 26 characters looks short.
  const fits = '小'.repeat(25);
  const tooLong = '小'.repeat(26);
  assert.equal(Buffer.byteLength(titleForWorkstream(fits), 'utf8'), 79);
  assert.throws(() => titleForWorkstream(tooLong), (error) => error.code === CODES.TITLE_INVALID);
});

test('a refused title reports how much room there was', () => {
  try {
    titleForWorkstream('小'.repeat(26));
    assert.fail('should have thrown');
  } catch (error) {
    assert.equal(error.details.maxWorkstreamBytes, MAX_TITLE_BYTES - TITLE_PREFIX.length);
    assert.equal(error.details.workstreamBytes, 78);
  }
});

test('textOf joins only text blocks', () => {
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(textOf('bare'), 'bare');
  assert.equal(textOf(undefined), '');
  assert.equal(textOf([{ type: 'reasoning', text: 'x' }]), '');
});

test('turnReason projects the error branch without the full payload', () => {
  assert.deepEqual(turnReason({ kind: 'completed' }), { kind: 'completed' });
  assert.deepEqual(
    turnReason({ kind: 'error', error: { code: 'quota', message: 'out of credit', status: 402 } }),
    { kind: 'error', code: 'quota', message: 'out of credit', status: 402 },
  );
  assert.equal(turnReason(null), null);
});

test('foldLastTurn takes the last assistant text and the last turn end', () => {
  const records = [
    { type: 'event', event: { type: 'turn/start', seq: 1, data: { turn: 1 } } },
    { type: 'event', event: { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'first' }] } } } },
    { type: 'event', event: { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'second' }] } } } },
    { type: 'event', event: { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } } },
  ];
  const folded = foldLastTurn(records);
  assert.equal(folded.text, 'second');
  assert.equal(folded.seq, 3);
  assert.deepEqual(folded.reason, { kind: 'completed' });
});

test('foldLastTurn ignores an empty assistant message', () => {
  const folded = foldLastTurn([
    { type: 'event', event: { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'reasoning', text: 'thinking' }] } } } },
  ]);
  assert.equal(folded.text, null);
});

test('foldLastTurn tolerates an empty or malformed snapshot', () => {
  assert.deepEqual(foldLastTurn([]), { seq: null, reason: null, text: null });
  assert.deepEqual(foldLastTurn(undefined), { seq: null, reason: null, text: null });
  assert.deepEqual(foldLastTurn([null, 5, 'x']), { seq: null, reason: null, text: null });
});
