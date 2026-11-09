import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceTotal } from '../src/invoice.js';

test('empty invoice totals zero', () => {
  assert.equal(invoiceTotal([]), 0);
});

test('total multiplies price by quantity', () => {
  assert.equal(invoiceTotal([
    { unitPrice: 12, quantity: 3 },
    { unitPrice: 7, quantity: 2 },
  ]), 50);
});
