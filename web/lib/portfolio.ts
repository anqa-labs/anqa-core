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

/** Wrapper header: disc + owner + market tag + bump + reserved + high water. */
export const PF_HEADER = 8 + 32 + 8 + 1 + 16 + 8;
/** Isolated margin adds two per-asset arrays before the kernel bytes. */
export const PF_MAX_ASSETS = 12;
export const PF_COLLATERAL = PF_HEADER;
export const PF_ENTRY = PF_COLLATERAL + PF_MAX_ASSETS * 16;
/** Where the kernel's own bytes start inside a raw portfolio account. */
export const PF_INNER = PF_ENTRY + PF_MAX_ASSETS * 16;

/** Collateral the trader put behind `assetIndex`, in USD. */
export function collateralOfRaw(data: Uint8Array, assetIndex: number): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const at = PF_COLLATERAL + assetIndex * 16;
  if (at + 8 > data.length) return 0;
  return Number(view.getBigUint64(at, true)) / 1e6;
}

/** Blended entry for `assetIndex`, quote atoms per lot. */
export function entryOfRaw(data: Uint8Array, assetIndex: number): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const at = PF_ENTRY + assetIndex * 16;
  if (at + 8 > data.length) return 0;
  return Number(view.getBigUint64(at, true)) / 1e6;
}

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

// ── the engine's asset slot ──────────────────────────────────────────────
// Pinned by the same test as the portfolio offsets above.
const SLOT_ANCHOR_DISC = 8;
const ENGINE_SLOT_OFFSET = 8; // the asset tag precedes the engine slot
const OI_LONG = 273; // u128 LE, POS_SCALE units

/**
 * Aggregate open interest, in quote atoms.
 *
 * Long-side notional equals short-side by construction — a perp fill mints
 * one of each — so one number sizes the venue. It is safe to publish for
 * exactly the reason positions are not: it is a total, and a total names
 * nobody.
 */
export function readOpenInterest(data: Uint8Array): string | null {
  const base = SLOT_ANCHOR_DISC + ENGINE_SLOT_OFFSET + OI_LONG;
  if (data.length < base + 16) return null;
  const oiQ = u(data, base, 16);
  // POS_SCALE units of base lots — report lots, the unit the book speaks.
  return (oiQ / POS_SCALE).toString();
}

/**
 * Equity, preferring the kernel's own certificate but never trusting it blindly.
 *
 * The health cert is a **cache**, not a running total. The kernel stamps it
 * during a refresh and it goes stale the moment the crank advances an epoch —
 * and on an account that has deposited but never traded it has simply never
 * been written, so it reads as zero.
 *
 * Reading that zero as "you have no equity" is how a funded account came to
 * show $0.00 free margin. Capital plus unrealised PnL is what the kernel would
 * certify anyway, so fall back to it rather than reporting a cache miss as
 * poverty. On-chain nothing depended on this: `place_order` refreshes the
 * account itself before it checks margin.
 */
export function equity(k: KernelState): bigint {
  return k.certValid && k.certifiedEquity > 0n ? k.certifiedEquity : k.capital + k.pnl;
}

/** True when the number above came from the fallback rather than the kernel. */
export function equityIsEstimated(k: KernelState): boolean {
  return !(k.certValid && k.certifiedEquity > 0n);
}

/** Free collateral: equity minus what positions and resting orders hold. */
export function freeMargin(k: KernelState, reservedByOrders: bigint): bigint {
  const eq = equity(k);
  if (eq <= 0n) return 0n;
  const committed = k.initialRequirement + reservedByOrders;
  const free = eq - committed;
  return free > 0n ? free : 0n;
}
