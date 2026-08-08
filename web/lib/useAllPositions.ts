"use client";

import { useEffect, useRef, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { anqaAccounts, ER_RPC } from "./anqa";
import { cachedToken, rpcWithToken } from "./teeSession";
import { collateralOfRaw, entryOfRaw, readKernel, PF_INNER } from "./portfolio";
import { MARKETS, type MarketInfo } from "./markets";

export type CrossPosition = {
  market: MarketInfo;
  isLong: boolean;
  lots: number;
  /** Base-asset size, e.g. 1.586 BTC. */
  size: number;
  /** Kernel-marked unrealised PnL of this market's portfolio, USD. */
  pnl: number;
  /** Initial margin this market's portfolio holds, USD. */
  marginUsd: number;
  /** The anchored entry (per whole asset). Anchored at the moment the leg's
   *  size last changed; falls back to the current mark on a fresh browser. */
  entry: number | null;
  /** Collateral locked behind this position — the portfolio's capital, USD.
   *  Isolated margin: this is the most the position can lose. */
  legMarginUsd: number;
  /** Venue mark, per whole asset. */
  mark: number | null;
  /** Liquidation price, per whole asset. Isolated margin makes this exact:
   *  only this portfolio's own equity backs the position, so the number
   *  never moves with the trader's other markets. Null when the position's
   *  equity covers it to zero. */
  liq: number | null;
};

/** Mirrors the program's MAINTENANCE_MARGIN_BPS (250). */
const MAINT_FRAC = 0.025;

/**
 * Every position this wallet holds — from ONE account.
 *
 * The account is the trader's deposit ledger: every market trades from it.
 * Isolation is per position, recorded inside it as collateral and blended
 * entry per asset, so each row's margin is the amount that position can
 * actually lose and its liquidation price follows from that alone.
 */
// Same reasoning as useAllOrders: positions move on fills, not on frames.
export function useAllPositions(pollMs = 1500): CrossPosition[] {
  const wallet = useAnchorWallet();
  const [rows, setRows] = useState<CrossPosition[]>([]);
  const busy = useRef(false);

  useEffect(() => {
    if (!wallet) {
      setRows([]);
      return;
    }
    const owner = wallet.publicKey;
    // Portfolios are private too, so the same rule as the book applies: read
    // unauthenticated and the rollup answers `null`, which this hook cannot
    // tell apart from "flat". Reuse the token `useAnqa` minted.
    let token: string | null = null;
    let conn = new Connection(rpcWithToken(ER_RPC, null), "confirmed");
    const connect = () => {
      const fresh = cachedToken(owner);
      if (fresh !== token) {
        token = fresh;
        conn = new Connection(rpcWithToken(ER_RPC, token), "confirmed");
      }
      return conn;
    };
    const perMarket = MARKETS.map((m) => anqaAccounts(new BN(m.id), new BN(m.groupId)));
    const account = perMarket[0].portfolioOf(owner);
    const oracleKeys = perMarket.map((a) => a.oracleState);
    const keys = [account, ...oracleKeys];

    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const infos = await connect().getMultipleAccountsInfo(keys);
        const pfInfo = infos[0];
        if (!pfInfo) {
          setRows([]);
          return;
        }
        const raw = Uint8Array.from(pfInfo.data);
        const kernel = readKernel(raw.subarray(PF_INNER));
        const out: CrossPosition[] = [];
        for (let i = 0; i < MARKETS.length; i++) {
          const m = MARKETS[i];
          const p = kernel.positions.find((x) => x.assetIndex === m.assetIndex);
          if (!p) continue;

          const oracleInfo = infos[1 + i];
          // OracleState: 8-byte discriminator, market_id u64, then last_price.
          const markLot = oracleInfo
            ? Number(oracleInfo.data.readBigUInt64LE(16)) / 1e6
            : null;
          // Entry comes off the chain now: the program blends it as fills
          // settle, so it survives a new browser and matches what the
          // liquidator measures against.
          const entryLot = entryOfRaw(raw, m.assetIndex);
          const entry = entryLot > 0 ? entryLot / m.lotFrac : null;
          const size = Number(p.lots) * m.lotFrac;
          // The collateral this position stands on — its whole risk.
          const collateral = collateralOfRaw(raw, m.assetIndex);

          // Isolated liquidation: this portfolio's equity is the ONLY money
          // behind the position, so the price that spends it down to the
          // maintenance requirement is exact, not an estimate:
          //   long:  E + s·(P − mark) = f·s·P  →  P = (mark − E/s) / (1 − f)
          //   short: E + s·(mark − P) = f·s·P  →  P = (mark + E/s) / (1 + f)
          const markAsset = markLot === null ? null : markLot / m.lotFrac;
          let liq: number | null = null;
          if (markAsset !== null && size > 0 && collateral > 0 && entry !== null) {
            liq = p.isLong
              ? (entry - collateral / size) / (1 - MAINT_FRAC)
              : (entry + collateral / size) / (1 + MAINT_FRAC);
            if (p.isLong && liq <= 0) liq = null;
          }

          out.push({
            market: m,
            isLong: p.isLong,
            lots: Number(p.lots),
            size,
            pnl:
              entry !== null && markAsset !== null
                ? (p.isLong ? markAsset - entry : entry - markAsset) * size
                : 0,
            marginUsd: collateral,
            entry,
            // Isolated: what this position can lose, and nothing else.
            legMarginUsd: collateral,
            mark: markAsset,
            liq,
          });
        }
        setRows(out);
      } catch {
        // transient RPC failures keep the previous view
      } finally {
        busy.current = false;
      }
    };

    tick();
    const t = setInterval(tick, pollMs);
    return () => clearInterval(t);
  }, [wallet, pollMs]);

  return rows;
}
