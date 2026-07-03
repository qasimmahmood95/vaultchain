// MoneyService — the single owner of decimal-string <-> integer-minor-unit
// conversion and rounding (PRD §A.2). Money is never a float: all arithmetic
// is bigint, scaled by the asset's own `decimals`. Rounding mode is
// round-half-even, applied in exactly one place (roundHalfEvenDiv).

import { unprocessable } from '../errors.js';

const AMOUNT_RE = /^\d+(\.\d+)?$/;

/** Parse a decimal string into integer minor units using the asset's decimals. */
export function toMinor(amount: string, decimals: number): bigint {
  if (!AMOUNT_RE.test(amount)) {
    throw unprocessable('invalid-amount', `Amount "${amount}" is not a valid decimal string`);
  }
  const [whole = '0', fraction = ''] = amount.split('.');
  if (fraction.length > decimals) {
    throw unprocessable(
      'invalid-amount-scale',
      `Amount "${amount}" has ${fraction.length} decimal places; asset allows ${decimals}`,
    );
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/** Format integer minor units as a fixed-precision decimal string. */
export function fromMinor(minor: bigint, decimals: number): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(decimals, '0');
  const body = decimals === 0 ? whole.toString() : `${whole}.${fraction}`;
  return negative ? `-${body}` : body;
}

/**
 * Integer division with round-half-even (banker's rounding).
 * The one rounding mode in the platform; both operands must be non-negative.
 */
export function roundHalfEvenDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n) {
    throw new Error('roundHalfEvenDiv requires numerator >= 0 and denominator > 0');
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = remainder * 2n;
  if (twice > denominator) return quotient + 1n;
  if (twice < denominator) return quotient;
  // exactly half: round to even
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/** Withdrawal fee on an amount in minor units, at the given basis points. */
export function feeFor(amountMinor: bigint, feeBps: bigint): bigint {
  return roundHalfEvenDiv(amountMinor * feeBps, 10_000n);
}
