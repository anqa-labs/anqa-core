"use client";

import { useEffect, useRef, useState } from "react";
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { anqaAccounts, BASE_RPC, ER_RPC, walkSide } from "./anqa";
import { cachedToken, rpcWithToken } from "./teeSession";
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
  /** Withheld from the public depth ladder — resting, but invisible. */
  hidden: boolean;
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
export function useAllOrders(pollMs = 500): CrossOrder[] {
  const wallet = useAnchorWallet();
  const [rows, setRows] = useState<CrossOrder[]>([]);
  const busy = useRef(false);

  useEffect(() => {
    if (!wallet) {
      setRows([]);
      return;
    }
    const owner = wallet.publicKey;
    // The book is private: an unauthenticated read is served `null`, which
    // renders as "you have no orders" rather than as the refusal it is. So
    // carry the session token `useAnqa` already minted. Rebuilt per poll
    // because the token may not exist yet at mount.
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
    // Not the book — the trader's own mirror of it. A trader is not a member
    // of the book's permission and never will be: membership grants sight of
    // *everyone's* resting orders and owners, which is the one thing the venue
    // promises nobody has. So the program projects each trader's own rows into
    // an account only they may read, and this reads that.
    const mirrorKeys = MARKETS.map(
      (m) => anqaAccounts(new BN(m.id), new BN(m.groupId)).ordersOf(owner)
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
        const infos = await connect().getMultipleAccountsInfo(mirrorKeys);
        const out: CrossOrder[] = [];
        MARKETS.forEach((m, i) => {
          const info = infos[i];
          // No mirror yet on a market this wallet has never traded, and
          // `null` from a wallet that is simply not permitted. Both mean
          // "nothing to show here" and neither is an error.
          if (!info) return;
          let mirror: any;
          try {
            mirror = coder.decode("traderOrders", info.data);
          } catch {
            return;
          }
          const n = Number(mirror.count);
          for (let r = 0; r < n; r++) {
            const row = mirror.rows[r];
            out.push({
              market: m,
              side: Number(row.side) === 0 ? "bid" : "ask",
              priceInTicks: Number(row.priceInTicks.toString()),
              baseLots: Number(row.baseLots.toString()),
              clientOrderId: row.clientOrderId,
              hidden: Number(row.hidden) === 1,
              dark: dark[m.id] ?? true,
            });
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
