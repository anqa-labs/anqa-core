"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { useAnchorWallet, useWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey } from "@solana/web3.js";
import { keypairWallet, sessionKeypair } from "./session";
import { rpcWithToken, teeToken } from "./teeSession";
import { DEFAULT_MARKET_ID, marketById } from "./markets";
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
  /** The on-chain session grant for this owner, if one exists. */
  grant: { sessionKey: string; expiresAt: number } | null;
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
  grant: null,
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
// 2s, not 500ms. This is the one hook that falls back to the BASE layer, so
// every open tab spends the venue's base-RPC budget four times over at 500ms
// — and the keeper is competing for the same quota to settle fills. Balances
// and marks do not move fast enough for anyone to notice the difference; the
// order book (useDepth) is what makes the terminal feel live, and that still
// reads the rollup, which is not rate limited.
export function useAnqa(mid: number = DEFAULT_MARKET_ID, pollMs = 2000) {
  const wallet = useAnchorWallet();
  const [state, setState] = useState<VenueState>(EMPTY);
  const busy = useRef(false);

  const marketBN = useMemo(() => new BN(mid), [mid]);
  const groupBN = useMemo(() => new BN(marketById(mid).groupId), [mid]);
  const acc = useMemo(
    () => anqaAccounts(marketBN, groupBN),
    [marketBN, groupBN]
  );

  // A market switch is a hard context change: wipe the view and the cached
  // base-layer picture rather than briefly showing the old market's numbers.
  useEffect(() => {
    setState(EMPTY);
    baseCache.current = null;
  }, [mid]);
  // The private rollup filters reads per account, so the connection has to
  // carry an identity. Minted once from a wallet signature and cached for its
  // 30-day life; until it arrives we read anonymously, which is enough for
  // public accounts (markets, depth, the tape) and returns nothing for the
  // book — the honest degradation rather than a blank screen.
  const { signMessage } = useWallet();
  const [erToken, setErToken] = useState<string | null>(null);
  const [erAuthState, setErAuthState] = useState<
    "anonymous" | "authorizing" | "ready" | "unavailable"
  >("anonymous");
  const authOwnerKey = wallet?.publicKey?.toBase58() ?? null;
  const signMessageRef = useRef(signMessage);
  useEffect(() => {
    signMessageRef.current = signMessage;
  }, [signMessage]);
  useEffect(() => {
    let stop = false;
    if (!authOwnerKey) {
      setErToken(null);
      setErAuthState("anonymous");
      return;
    }
    setErAuthState("authorizing");
    teeToken(ER_RPC, new PublicKey(authOwnerKey), signMessageRef.current)
      .then((t) => {
        if (stop) return;
        setErToken(t);
        setErAuthState(t ? "ready" : "unavailable");
      })
      .catch(() => {
        if (stop) return;
        setErToken(null);
        setErAuthState("unavailable");
      });
    return () => {
      stop = true;
    };
    // `signMessage` is intentionally read through a ref. Some adapters return
    // a new function identity on every provider render; depending on it made
    // this effect mint the same token repeatedly and reopened the wallet after
    // every approval.
  }, [authOwnerKey]);

  const conns = useMemo(
    () => ({
      base: new Connection(BASE_RPC, "confirmed"),
      er: new Connection(rpcWithToken(ER_RPC, erToken), "confirmed"),
    }),
    [erToken]
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
        // The rollup validates on execution; preflight against it only adds
        // a round-trip and a second chance to fail. Base keeps preflight.
        skipPreflight: layer === "er",
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

  /**
   * The slow-changing base-layer picture, cached between full refreshes.
   *
   * Prices, the book and PnL tick every second and live in the rollup, whose
   * RPC tolerates that. Market config, delegation flags and the ledger live
   * on the public devnet endpoint, which rate-limits at a handful of
   * requests per second — so the fast loop reuses this cache and only a
   * periodic full refresh (or an explicit one after an action) re-reads it.
   */
  const baseCache = useRef<{
    mid: number;
    owner: string | null;
    market: any;
    delegated: boolean;
    portfolioDelegated: boolean;
    ledger: any;
    pfBaseInfo: any;
    grant: { sessionKey: string; expiresAt: number } | null;
  } | null>(null);

  const refresh = useCallback(
    async (opts?: { fast?: boolean }) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const owner = wallet?.publicKey ?? null;
        const ownerKey = owner?.toBase58() ?? null;

        // One batched read per layer, not one RPC call per account. The public
        // devnet endpoint rate-limits at a handful of requests per second, and
        // a terminal that polls politely is the difference between live data
        // and a console full of 429s.
        const coder = programs.base.coder.accounts;
        const dec = (
          name: string,
          info: { data: Buffer } | null | undefined
        ) => {
          if (!info) return null;
          try {
            return coder.decode(name, info.data);
          } catch {
            return null;
          }
        };

        const pfKey = owner ? acc.portfolioOf(owner) : null;
        const full =
          !opts?.fast ||
          !baseCache.current ||
          baseCache.current.owner !== ownerKey ||
          baseCache.current.mid !== mid;

        if (full) {
          const baseKeys = [
            acc.market,
            acc.book,
            ...(owner
              ? [pfKey!, acc.ledgerOf(owner!), acc.sessionOf(owner!)]
              : []),
          ];
          const baseInfos = await conns.base
            .getMultipleAccountsInfo(baseKeys)
            .catch(() => baseKeys.map(() => null));
          const [
            marketInfo,
            bookBaseInfo,
            pfBaseInfo,
            ledgerInfo,
            sessionInfo,
          ] = baseInfos;
          const grantAcct = owner ? dec("tradeSession", sessionInfo) : null;
          baseCache.current = {
            mid,
            owner: ownerKey,
            // Market config is base-resident by design.
            market: dec("market", marketInfo),
            // Is the book delegated? Its base-layer owner answers that.
            delegated: bookBaseInfo?.owner?.equals(DLP) ?? false,
            // The portfolio answers from whichever side currently owns it.
            portfolioDelegated: pfBaseInfo?.owner?.equals(DLP) ?? false,
            ledger: owner ? dec("userDepositLedger", ledgerInfo) : null,
            pfBaseInfo,
            grant: grantAcct
              ? {
                  sessionKey: grantAcct.sessionKey.toBase58(),
                  expiresAt: Number(grantAcct.expiresAt.toString()),
                }
              : null,
          };
        }
        const {
          market,
          delegated,
          portfolioDelegated,
          ledger,
          pfBaseInfo,
          grant,
        } = baseCache.current!;

        const liveConn = delegated ? conns.er : conns.base;
        const liveKeys = [acc.oracleState, acc.book, acc.tape, acc.assetSlots];
        if (owner && portfolioDelegated && delegated) liveKeys.push(pfKey!);
        const liveInfos = await liveConn
          .getMultipleAccountsInfo(liveKeys)
          .catch(() => liveKeys.map(() => null));
        const [oracleInfo, bookLiveInfo, tapeInfo, slotsInfo, pfErInfo] =
          liveInfos;

        const oracle = dec("oracleState", oracleInfo);
        const book = dec("book", bookLiveInfo);
        const tapeAcct = dec("fillTape", tapeInfo);

        // Raw bytes: the kernel's engine slot is opaque to Anchor, and the
        // one field worth publishing is aggregate open interest.
        const openInterest = slotsInfo
          ? readOpenInterest(slotsInfo.data)
          : null;

        // A delegated portfolio under an undelegated book is the rare
        // in-between; it pays for the one extra read it actually needs.
        const pfInfo = !owner
          ? null
          : !portfolioDelegated
          ? pfBaseInfo
          : delegated
          ? pfErInfo
          : await conns.er.getAccountInfo(pfKey!).catch(() => null);
        const portfolio = dec("portfolio", pfInfo);

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
          markPrice: oracle
            ? Number((oracle as any).lastPrice.toString())
            : null,
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
          grant,
          loading: false,
          error: null,
        });
      } catch (e: any) {
        setState((s) => ({
          ...s,
          loading: false,
          error: String(e?.message ?? e),
        }));
      } finally {
        busy.current = false;
      }
    },
    [acc, conns, programs, wallet, mid]
  );

  useEffect(() => {
    // Fast ticks ride the rollup RPC alone; every eighth tick re-reads the
    // slow base-layer picture too. Explicit refresh() calls (after an
    // action) are always full.
    let n = 0;
    refresh();
    const t = setInterval(() => {
      n += 1;
      refresh(n % 8 === 0 ? undefined : { fast: true });
    }, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  /** The browser-held key that signs trades once the owner grants it. */
  const sessionKp = useMemo(
    () => (wallet ? sessionKeypair(wallet.publicKey) : null),
    [wallet]
  );

  /** Is one-click trading live: on-chain grant matches our key and is fresh? */
  const sessionActive =
    !!sessionKp &&
    !!state.grant &&
    state.grant.sessionKey === sessionKp.publicKey.toBase58() &&
    state.grant.expiresAt > Date.now() / 1000 + 60;

  /** Session-signed rollup program, regardless of whether the grant is
   *  visible in state yet — for the claim that immediately follows a grant. */
  const sessionProgram = useCallback(() => {
    if (!sessionKp) return null;
    return new Program(
      idl as Idl,
      new AnchorProvider(conns.er, keypairWallet(sessionKp) as never, {
        commitment: "processed",
        skipPreflight: true,
      })
    ) as any as Program;
  }, [sessionKp, conns]);

  /**
   * The only program trading calls may go through.
   *
   * Deliberately never falls back to the connected wallet. A stale session
   * should ask to be renewed once; it must not turn an ordinary order or close
   * into a surprise wallet popup.
   */
  const programForTrading = useCallback(() => {
    if (sessionActive && sessionKp) {
      return sessionProgram();
    }
    return null;
  }, [sessionActive, sessionKp, sessionProgram]);

  /** Spread into a trading ctx to route signing through the session key. */
  const tradeExtra =
    sessionActive && sessionKp && wallet
      ? {
          trader: sessionKp.publicKey,
          session: acc.sessionOf(wallet.publicKey),
        }
      : {};

  /** Session accounts independent of React's cached grant read. Used directly
   * after a grant so the first order is session-signed too. */
  const sessionTradeExtra =
    sessionKp && wallet
      ? {
          trader: sessionKp.publicKey,
          session: acc.sessionOf(wallet.publicKey),
        }
      : null;

  return {
    ...state,
    refresh,
    acc,
    conns,
    programFor,
    wallet,
    marketId: marketBN,
    marketInfo: marketById(mid),
    sessionKp,
    sessionActive,
    sessionProgram,
    programForTrading,
    tradeExtra,
    sessionTradeExtra,
    privateRpcReady:
      !ER_RPC.split("?")[0].includes("-tee.") || erAuthState === "ready",
    privateRpcAuthState: erAuthState,
  };
}

export type Anqa = ReturnType<typeof useAnqa>;
export { BN, PROGRAM_ID };
