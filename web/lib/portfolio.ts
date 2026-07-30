/**
 * Reading a portfolio's kernel state.
 *
 * The risk kernel's account is stored as opaque bytes — Anchor cannot
 * describe a foreign type, and the boundary is honest: only Percolator
 * interprets its own state. But a terminal has to show a trader their
 * position, so this file decodes the handful of fields the UI needs.
 *
 * **The offsets below are pinned by `programs/anqa-core/tests/layout.rs`.**
 * If a Percolator bump moves a field, that test fails rather than this file
 * silently rendering the wrong number onto somebody's screen.
 */

const CAPITAL = 132; // u128 LE
const PNL = 148; // i128 LE
const LEGS = 340;
const LEG_STRIDE = 144;
const LEG_ACTIVE = 0; // u8
const LEG_ASSET_INDEX = 1; // u32 LE
const LEG_SIDE = 13; // u8: 0 = long, 1 = short
const LEG_BASIS_POS_Q = 14; // i128 LE
const HEALTH_CERT = 2484;
const CERT_EQUITY = 0; // i128 LE
const CERT_INITIAL_REQ = 16; // u128 LE
const CERT_VALID = 120; // u8
const MAX_LEGS = 4;

/** Position sizes are carried in POS_SCALE units; the book speaks base lots. */
export const POS_SCALE = 1_000_000n;

function u(bytes: Uint8Array, offset: number, len: number): bigint {
  let v = 0n;
  for (let i = len - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i] ?? 0);
  return v;
}

function i(bytes: Uint8Array, offset: number, len: number): bigint {
  const v = u(bytes, offset, len);
  const bits = BigInt(len * 8);
  return v >= 1n << (bits - 1n) ? v - (1n << bits) : v;
}

export type KernelPosition = {
  assetIndex: number;
  isLong: boolean;
  /** Position size in base lots. */
  lots: bigint;
};

export type KernelState = {
  /** Withdrawable principal, quote atoms. */
  capital: bigint;
  /** Unrealised PnL, quote atoms. Junior to losses until realised. */
  pnl: bigint;
  /** Equity as the kernel last certified it. Signed: bankruptcy is negative. */
  certifiedEquity: bigint;
  /** Margin committed to open positions. */
  initialRequirement: bigint;
  certValid: boolean;
  positions: KernelPosition[];
};

/** Decode a Portfolio's `inner` byte array. */
export function readKernel(inner: number[] | Uint8Array): KernelState {
  const b = inner instanceof Uint8Array ? inner : Uint8Array.from(inner);

  const positions: KernelPosition[] = [];
  for (let n = 0; n < MAX_LEGS; n++) {
    const base = LEGS + n * LEG_STRIDE;
    if (base + LEG_STRIDE > b.length) break;
    if (b[base + LEG_ACTIVE] !== 1) continue;
    const basis = i(b, base + LEG_BASIS_POS_Q, 16);
    if (basis === 0n) continue;
    positions.push({
      assetIndex: Number(u(b, base + LEG_ASSET_INDEX, 4)),
      isLong: b[base + LEG_SIDE] === 0,
      lots: (basis < 0n ? -basis : basis) / POS_SCALE,
    });
  }

  return {
    capital: u(b, CAPITAL, 16),
    pnl: i(b, PNL, 16),
    certifiedEquity: i(b, HEALTH_CERT + CERT_EQUITY, 16),
    initialRequirement: u(b, HEALTH_CERT + CERT_INITIAL_REQ, 16),
    certValid: b[HEALTH_CERT + CERT_VALID] === 1,
    positions,
  };
}

/** Free collateral: equity minus what positions and resting orders hold. */
export function freeMargin(k: KernelState, reservedByOrders: bigint): bigint {
  if (k.certifiedEquity <= 0n) return 0n;
  const committed = k.initialRequirement + reservedByOrders;
  const free = k.certifiedEquity - committed;
  return free > 0n ? free : 0n;
}
