// Fractional indexing for z-order.
//
// Every element carries a string key; sorting keys gives stacking order.
// To put something between two neighbours we invent a key that sorts
// strictly between theirs, so "bring to front" never has to renumber
// anyone else, and two peers reordering at once never fight over slots.
// Equal keys (two peers picked the same spot) are tie-broken by element id.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function digit(c: string | undefined): number {
  return c === undefined ? 0 : DIGITS.indexOf(c);
}

/**
 * A key strictly between `a` and `b` (null b means "the top").
 * Requires a < b and that neither ends in "0", which the outputs preserve.
 */
export function keyBetween(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`keyBetween: ${a} >= ${b}`);
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + keyBetween(a.slice(n), b.slice(n));
  }
  const da = digit(a[0]);
  const db = b !== null ? digit(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + keyBetween(a.slice(1), null);
}
