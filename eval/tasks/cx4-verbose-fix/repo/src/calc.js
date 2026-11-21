"use strict";
// Small money helpers. Amounts are integer cents.
function addCents(a, b) { return a + b; }
function percentOf(cents, pct) { return Math.floor(cents * pct / 100); }          // rounds down
function splitEvenly(cents, parts) {
  const base = Math.floor(cents / parts);
  return Array.from({ length: parts }, () => base);                                   // drops the remainder
}
function clampPositive(cents) { return cents < 0 ? 0 : cents; }
function formatCents(cents) { return `$${(cents / 100).toFixed(2)}`; }
module.exports = { addCents, percentOf, splitEvenly, clampPositive, formatCents };
