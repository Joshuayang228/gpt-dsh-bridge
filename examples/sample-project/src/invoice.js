/**
 * DELIBERATE BUG: item quantities are ignored.
 * DSH is expected to fix this as part of the opt-in demonstration.
 */
export function invoiceTotal(items) {
  return items.reduce((sum, item) => sum + item.unitPrice, 0);
}
