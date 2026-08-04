"use client";

import { useEffect, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { ER_RPC, PROGRAM_ID } from "./anqa";

/** A price level as the venue publishes it: a price and everything resting
 *  there, with nothing about whose orders compose it. */
export type Level = { priceInTicks: number; baseLots: number };

export type Depth = {
  bids: Level[];
  asks: Level[];
  /** Everything resting, including whatever sits past the published levels. */
  totalBidLots: number;
  totalAskLots: number;
};

const DEPTH_LEVELS = 12;
// disc(8) + market_id(8) + seq(8), then the two level arrays.
const LEVELS_AT = 24;
const LEVEL_BYTES = 16;
const TOTALS_AT = LEVELS_AT + 2 * DEPTH_LEVELS * LEVEL_BYTES;

/**
 * The book's public depth.
 *
 * A dark book hides which order is yours, how large it is on its own, and
 * the position it belongs to. It does not need to hide how much is bid at a
 * price — that protects nobody and leaves a taker unable to size a trade, so
 * the program publishes the aggregate and the terminal reads it here.
 */
export function useDepth(marketId: number, pollMs = 1500): Depth | null {
  const [depth, setDepth] = useState<Depth | null>(null);

  useEffect(() => {
    const conn = new Connection(ER_RPC, "confirmed");
    const le = new BN(marketId).toArrayLike(Buffer, "le", 8);
    const key = PublicKey.findProgramAddressSync(
      [Buffer.from("anqa_depth"), le],
      PROGRAM_ID
    )[0];
    let stop = false;

    const read = (data: Buffer): Depth => {
      const side = (base: number, count: number): Level[] => {
        const out: Level[] = [];
        for (let i = 0; i < count; i++) {
          const at = base + i * LEVEL_BYTES;
          const lots = Number(data.readBigUInt64LE(at + 8));
          if (lots === 0) continue;
          out.push({ priceInTicks: Number(data.readBigUInt64LE(at)), baseLots: lots });
        }
        return out;
      };
      const bidCount = data.readUInt8(TOTALS_AT + 16);
      const askCount = data.readUInt8(TOTALS_AT + 17);
      return {
        bids: side(LEVELS_AT, bidCount),
        asks: side(LEVELS_AT + DEPTH_LEVELS * LEVEL_BYTES, askCount),
        totalBidLots: Number(data.readBigUInt64LE(TOTALS_AT)),
        totalAskLots: Number(data.readBigUInt64LE(TOTALS_AT + 8)),
      };
    };

    const tick = async () => {
      const info = await conn.getAccountInfo(key).catch(() => null);
      if (stop) return;
      setDepth(info ? read(info.data) : null);
    };
    tick();
    const t = setInterval(tick, pollMs);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [marketId, pollMs]);

  return depth;
}
