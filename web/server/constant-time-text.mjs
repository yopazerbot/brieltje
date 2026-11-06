import { timingSafeEqual } from 'node:crypto';

/** Compare UTF-8 text without hashing passwords or returning early for different lengths. */
export function sameText(a, b) {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  const length = Math.max(x.length, y.length);
  const left = Buffer.alloc(length);
  const right = Buffer.alloc(length);
  x.copy(left);
  y.copy(right);
  const equal = timingSafeEqual(left, right);
  return equal && x.length === y.length;
}
