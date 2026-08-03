"use client";

import { useEffect, useRef, useState } from "react";
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { anqaAccounts, BASE_RPC, ER_RPC, walkSide } from "./anqa";
import idl from "./anqa_core.json";
import { MARKETS, type MarketInfo } from "./markets";

export type CrossOrder = {
  market: MarketInfo;
  side: "bid" | "ask";
  /** Limit price in ticks — convert with the row's own market shape. */
  priceInTicks: number;
  /** Remaining size in base lots. */
  baseLots: number;
  clientOrderId: BN;
  /** Whether this market's book hides orders from other traders. */
  dark: boolean;
};

/**
 * Every resting order this wallet has, on every market.
 *
 * A submitted order lives on its market's book until a counterparty fills it
 * or the trader cancels — and the trader should not have to visit each market
 * to remember what they left resting. One batched rollup read covers all
 * books; each is walked in priority order and filtered to this wallet.
 */
export function useAllOrders(pollMs = 2000): CrossOrder[] {
  const wallet = useAnchorWallet();
  const [rows, setRows] = useState<CrossOrder[]>([]);
  const busy = useRef(false);

  useEffect(() => {
    if (!wallet) {
      setRows([]);
      return;
    }
    const owner = wallet.publicKey;
    const conn = new Connection(ER_RPC, "confirmed");
    // Decode through a Program, not a raw BorshAccountsCoder: Anchor
    // camelCases the IDL's account names ("Book" → "book") only on this
    // path, and the rest of the app addresses accounts by the camel name.
    const coder = (
      new Program(
        idl as Idl,
        new AnchorProvider(conn, { publicKey: PublicKey.default } as never, {
          commitment: "confirmed",
        })
      ) as any
    ).coder.accounts;
    const bookKeys = MARKETS.map(
      (m) => anqaAccounts(new BN(m.id), new BN(m.groupId)).book
    );

    // Dark flags live in market config on base and never change mid-session;
    // one read at mount is enough.
    const dark: Record<number, boolean> = {};
    new Connection(BASE_RPC, "confirmed")
      .getMultipleAccountsInfo(
        MARKETS.map((m) => anqaAccounts(new BN(m.id), new BN(m.groupId)).market)
      )
      .then((infos) =>
        infos.forEach((info, i) => {
          if (!info) return;
          try {
            dark[MARKETS[i].id] = !!coder.decode("market", info.data).dark;
          } catch {}
        })
      )
      .catch(() => {});

    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const infos = await conn.getMultipleAccountsInfo(bookKeys);
        const out: CrossOrder[] = [];
        MARKETS.forEach((m, i) => {
          const info = infos[i];
          if (!info) return;
          let book: any;
          try {
            book = coder.decode("book", info.data);
          } catch {
            return;
          }
          for (const side of ["bid", "ask"] as const) {
            for (const o of walkSide(side === "bid" ? book.bids : book.asks)) {
              if (!o.trader.equals(owner)) continue;
              out.push({
                market: m,
                side,
                priceInTicks: Number(o.priceInTicks.toString()),
                baseLots: Number(o.baseLots.toString()),
                clientOrderId: o.clientOrderId,
                dark: dark[m.id] ?? true,
              });
            }
          }
        });
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
