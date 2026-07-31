"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey } from "@solana/web3.js";
import idl from "./anqa_core.json";
import { readOpenInterest } from "./portfolio";
import {
  anqaAccounts,
  BASE_RPC,
  DLP,
  ER_RPC,
  MARKET_ID,
  PROGRAM_ID,
  readTape,
  readTriggers,
  walkSide,
} from "./anqa";

export type VenueState = {
  /** Market config. Lives on base, clone-read by the rollup. */
  market: any | null;
  /** Where the book currently is. Delegated = trading is live in the rollup. */
  delegated: boolean;
  /** Whether *this wallet's* portfolio is in a rollup session. Not the same
   *  question as the venue's state, and must never be shown as if it were. */
  portfolioDelegated: boolean;
  markPrice: number | null;
  /** Public prints. The only thing a dark market shows the world. */
  tape: ReturnType<typeof readTape>;
  /** Orders THIS wallet can see: on a dark market, only its own. */
  myBids: ReturnType<typeof walkSide>;
  myAsks: ReturnType<typeof walkSide>;
  /** Resting orders that exist but are unreadable — depth without detail. */
  hiddenBids: number;
  hiddenAsks: number;
  /** Fills matched on the book, awaiting the engine's settlement. */
  pendingFills: number;
  /** Lifetime prints on the tape (the ring only holds the last 128). */
  tapeCount: number;
  /**
   * Aggregate open interest in quote atoms — long side, which equals short.
   * Publishable precisely because it is aggregate: it sizes the venue without
   * exposing a single account.
   */
  openInterest: string | null;
  portfolio: any | null;
  ledger: any | null;
  triggers: ReturnType<typeof readTriggers>;
  loading: boolean;
  error: string | null;
};

const EMPTY: VenueState = {
  market: null,
  delegated: false,
  portfolioDelegated: false,
  markPrice: null,
  tape: [],
  myBids: [],
  myAsks: [],
  hiddenBids: 0,
  hiddenAsks: 0,
  pendingFills: 0,
  tapeCount: 0,
  openInterest: null,
  portfolio: null,
  ledger: null,
  triggers: [],
  loading: true,
  error: null,
};

/**
 * One hook, both layers.
 *
 * Every read is attempted against the rollup first and falls back to base:
 * a delegated account only answers from inside, an undelegated one only from
 * outside, and the terminal should not care which phase the venue is in.
 */
export function useAnqa(pollMs = 1500) {
  const wallet = useAnchorWallet();
  const [state, setState] = useState<VenueState>(EMPTY);
  const busy = useRef(false);

  const acc = useMemo(() => anqaAccounts(MARKET_ID), []);
  const conns = useMemo(
    () => ({
      base: new Connection(BASE_RPC, "confirmed"),
      er: new Connection(ER_RPC, "confirmed"),
    }),
    []
  );

  /**
   * Read-only programs, one per layer.
   *
   * Typed loosely on purpose: the IDL is loaded as JSON at runtime, so
   * Anchor's generated `AccountNamespace` cannot know our account names at
   * compile time. The names are checked by the e2e suites instead.
   */
  const programs = useMemo(() => {
    const mk = (c: Connection) =>
      new Program(
        idl as Idl,
        new AnchorProvider(c, { publicKey: PublicKey.default } as never, {
          commitment: "confirmed",
        })
      ) as any;
    return { base: mk(conns.base), er: mk(conns.er) };
  }, [conns]);

  /** Signing provider, bound to whichever layer the instruction belongs on. */
  const providerFor = useCallback(
    (layer: "base" | "er") => {
      if (!wallet) return null;
      return new AnchorProvider(conns[layer], wallet, {
        commitment: "confirmed",
        skipPreflight: false,
      });
    },
    [conns, wallet]
  );

  const programFor = useCallback(
    (layer: "base" | "er") => {
      const p = providerFor(layer);
      return p ? (new Program(idl as Idl, p) as any as Program) : null;
    },
    [providerFor]
  );

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const owner = wallet?.publicKey ?? null;

      // Market config is base-resident by design.
      const market = await programs.base.account.market
        .fetch(acc.market)
        .catch(() => null);

      // Is the book delegated? Its base-layer owner answers that.
      const bookInfo = await conns.base.getAccountInfo(acc.book).catch(() => null);
      const delegated = bookInfo?.owner?.equals(DLP) ?? false;
      const live = delegated ? programs.er : programs.base;

      const [oracle, book, tapeAcct, slotsInfo] = await Promise.all([
        live.account.oracleState.fetch(acc.oracleState).catch(() => null),
        live.account.book.fetch(acc.book).catch(() => null),
        live.account.fillTape.fetch(acc.tape).catch(() => null),
        // Raw bytes: the kernel's engine slot is opaque to Anchor, and the
        // one field worth publishing is aggregate open interest.
        (delegated ? conns.er : conns.base).getAccountInfo(acc.assetSlots).catch(() => null),
      ]);

      const openInterest = slotsInfo ? readOpenInterest(slotsInfo.data) : null;

      let portfolio: any = null;
      let ledger: any = null;
      let portfolioDelegated = false;
      if (owner) {
        const pfKey = acc.portfolioOf(owner);
        const [pfInfo, l] = await Promise.all([
          conns.base.getAccountInfo(pfKey).catch(() => null),
          programs.base.account.userDepositLedger
            .fetch(acc.ledgerOf(owner))
            .catch(() => null),
        ]);
        ledger = l;
        // The portfolio answers from whichever side currently owns it.
        portfolioDelegated = pfInfo?.owner?.equals(DLP) ?? false;
        if (pfInfo) {
          portfolio = await (portfolioDelegated ? programs.er : programs.base).account.portfolio
            .fetch(pfKey)
            .catch(() => null);
        }
      }

      // Split what we can read into "mine" and "someone's, but not mine".
      // On a lit market we see everything; on a dark one the book itself is
      // unreadable to non-members, and this loop simply finds nothing.
      let myBids: any[] = [];
      let myAsks: any[] = [];
      let hiddenBids = 0;
      let hiddenAsks = 0;
      if (book) {
        const bids = walkSide(book.bids as never);
        const asks = walkSide(book.asks as never);
        const mine = (o: any) => owner && o.trader.equals(owner);
        myBids = bids.filter(mine);
        myAsks = asks.filter(mine);
        hiddenBids = bids.length - myBids.length;
        hiddenAsks = asks.length - myAsks.length;
      }

      setState({
        market,
        delegated,
        portfolioDelegated,
        markPrice: oracle ? Number((oracle as any).lastPrice.toString()) : null,
        tape: tapeAcct ? readTape(tapeAcct as never) : [],
        myBids,
        myAsks,
        hiddenBids,
        hiddenAsks,
        pendingFills: book ? Number((book as any).pendingCount ?? 0) : 0,
        tapeCount: tapeAcct ? Number((tapeAcct as any).count.toString()) : 0,
        openInterest,
        portfolio,
        ledger,
        triggers: portfolio ? readTriggers((portfolio as any).triggers) : [],
        loading: false,
        error: null,
      });
    } catch (e: any) {
      setState((s) => ({ ...s, loading: false, error: String(e?.message ?? e) }));
    } finally {
      busy.current = false;
    }
  }, [acc, conns, programs, wallet]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  return { ...state, refresh, acc, conns, programFor, wallet, marketId: MARKET_ID };
}

export type Anqa = ReturnType<typeof useAnqa>;
export { BN, PROGRAM_ID };
