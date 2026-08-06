"use client";

import { useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { Button } from "./ui";
import { readableError } from "@/lib/anqa";
import { defundMarket, fundMarket, walletUsdc } from "@/lib/margin";
import type { Anqa } from "@/lib/useAnqa";

/**
 * Deposit and withdraw, the way a perp venue does it.
 *
 * USDC only — it is the venue's single collateral asset — and one row: what
 * this market holds against what the wallet holds. Depositing here is the
 * same act as putting collateral behind a trade, because on an isolated
 * venue they are the same thing: the market's balance IS the risk of any
 * position on it.
 */
export function DepositModal({
  anqa,
  open,
  onClose,
  onDone,
}: {
  anqa: Anqa;
  open: boolean;
  onClose: () => void;
  onDone: (msg: string, err?: boolean) => void;
}) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // Deposit and withdraw are opposite directions, not two buttons on one form.
  // Without a mode there is nothing to tell "max" which balance it means, and
  // it silently meant the wallet — so withdrawing from a funded account with
  // an empty wallet could not be given an amount at all.
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [wallet, setWallet] = useState(0);
  const [account, setAccount] = useState(0);
  // React disables the button on the next render. This ref closes the tiny
  // same-tick window in which a double click can enter the async handler twice
  // and ask the wallet to sign two custody transactions.
  const depositInFlight = useRef(false);

  const owner = anqa.wallet?.publicKey;
  const MINT = anqa.marketInfo.mint ? new PublicKey(anqa.marketInfo.mint) : null;

  useEffect(() => {
    if (!open || !owner || !MINT) return;
    let stop = false;
    const tick = async () => {
      const w = await walletUsdc(anqa.conns.base, MINT, owner);
      const info = await anqa.conns.er
        .getAccountInfo(anqa.acc.portfolioOf(owner))
        .catch(() => null);
      let a = 0;
      if (info) {
        const { readKernel, equity, PF_INNER } = await import("@/lib/portfolio");
        a = Number(equity(readKernel(Uint8Array.from(info.data.subarray(PF_INNER))))) / 1e6;
      }
      if (!stop) {
        setWallet(w);
        setAccount(a);
      }
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, owner?.toBase58(), anqa.marketInfo.id, busy]);

  if (!open) return null;

  const n = Number(amount) || 0;
  const depositLabel =
    !anqa.privateRpcReady && anqa.privateRpcAuthState === "authorizing"
      ? "Approve private session first"
      : !anqa.privateRpcReady
        ? "Private session unavailable"
        : wallet <= 0
          ? "No USDC in your wallet"
          : "Deposit";
  const ctx = () => ({
    acc: anqa.acc,
    marketId: anqa.marketId,
    owner: owner!,
    engine: owner!,
  });

  const faucet = async () => {
    if (!owner) return;
    setBusy("Minting");
    try {
      const r = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: owner.toBase58(), marketId: anqa.marketInfo.id }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Faucet failed");
      onDone("250,000 test USDC minted to your wallet");
    } catch (e: any) {
      onDone(readableError(e), true);
    } finally {
      setBusy(null);
    }
  };

  const doDeposit = async () => {
    if (depositInFlight.current) return;
    const base = anqa.programFor("base");
    // The base setup is owner-signed once; every rollup claim after that must
    // be signed by the browser session. Passing the wallet-backed ER program
    // here made each credit poll reopen Backpack even though the deposit had
    // already landed on Solana.
    const session = anqa.sessionProgram();
    if (!n || !base || !owner || !MINT || !anqa.sessionKp || !session) {
      return onDone("Enter an amount", true);
    }
    if (!anqa.privateRpcReady) {
      return onDone(
        anqa.privateRpcAuthState === "authorizing"
          ? "Approve the one-time private-session message first — no deposit has been submitted"
          : "Private session is unavailable; reconnect the wallet and approve its one-time message",
        true
      );
    }
    depositInFlight.current = true;
    setBusy("Depositing");
    try {
      await fundMarket(base, session, ctx(), {
        usd: account + n,
        mint: MINT,
        hideAccount: true,
        sessionKey: anqa.sessionKp.publicKey,
        sessionPda: anqa.acc.sessionOf(owner),
        need: {
          open: !anqa.portfolio,
          delegate: !anqa.portfolioDelegated,
          grant: !anqa.sessionActive,
        },
        conn: anqa.conns.base,
        onStep: (m) => setBusy(m),
      });
      onDone(`$${n.toLocaleString()} deposited to your account`);
      setAmount("");
      anqa.refresh();
    } catch (e: any) {
      const message = readableError(e);
      if (/deposit landed|rollup credit is lagging|previous .*deposit is already on solana/i.test(message)) {
        // Custody succeeded. Presenting this as a failed deposit invites the
        // trader to click again and transfer the same amount twice.
        onDone("A deposit is already on Solana. Its private balance is updating; no new transfer was submitted.");
        setAmount("");
        anqa.refresh();
        onClose();
      } else {
        onDone(message, true);
      }
    } finally {
      depositInFlight.current = false;
      setBusy(null);
    }
  };

  const doWithdraw = async () => {
    const base = anqa.programFor("base");
    const er = anqa.programFor("er");
    const amt = n || account;
    if (!amt || !base || !er || !owner || !MINT) return onDone("Nothing to withdraw", true);
    setBusy("Withdrawing");
    try {
      await defundMarket(base, er, ctx(), {
        usd: amt,
        mint: MINT,
        conn: anqa.conns.base,
        onStep: (m) => setBusy(m),
      });
      onDone(`$${amt.toLocaleString()} returned to your wallet`);
      setAmount("");
      anqa.refresh();
    } catch (e: any) {
      onDone(readableError(e), true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="w-full max-w-md bg-ink border border-line rounded-xl shadow-[0_24px_64px_rgba(0,0,0,0.6)] overflow-hidden">
        <header className="flex items-center h-11 px-4 border-b border-line-soft">
          <span className="text-[13px] font-semibold text-bright">Your trading account</span>
          <button
            onClick={() => !busy && onClose()}
            className="ml-auto h-7 w-7 grid place-items-center rounded text-dim hover:text-text hover:bg-raised transition-colors"
          >
            ✕
          </button>
        </header>

        <div className="p-4 flex flex-col gap-3">
          {/* the two balances, the way Flash lays them out */}
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-2 text-[11px]">
            <span className="text-dim uppercase tracking-[0.1em] text-[10px]">Token</span>
            <span className="text-dim uppercase tracking-[0.1em] text-[10px] text-right">
              In your account
            </span>
            <span className="text-dim uppercase tracking-[0.1em] text-[10px] text-right">
              Your wallet
            </span>

            <span className="font-medium text-bright">USDC</span>
            <span className="tnum text-right text-phoenix">
              ${account.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span className="tnum text-right text-text">
              ${wallet.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>

          <div className="flex p-0.5 bg-void border border-line rounded-lg">
            {(["deposit", "withdraw"] as const).map((m) => (
              <button
                key={m}
                disabled={!!busy}
                onClick={() => {
                  setMode(m);
                  setAmount("");
                }}
                className={`flex-1 h-8 text-[12px] rounded-md capitalize transition-colors ${
                  mode === m
                    ? "bg-line text-bright"
                    : "text-dim hover:text-text"
                }`}
              >
                {m}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 h-11 px-3 bg-void border border-line rounded-lg focus-within:border-phoenix-soft transition-colors">
            <input
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              inputMode="decimal"
              className="tnum flex-1 min-w-0 bg-transparent text-[16px] text-bright outline-none placeholder:text-dim/50"
            />
            <button
              onClick={() => {
                const cap = mode === "deposit" ? wallet : account;
                setAmount(cap > 0 ? cap.toFixed(2) : "");
              }}
              className="text-[10px] text-phoenix/80 hover:text-phoenix transition-colors"
            >
              max
            </button>
            <span className="text-[11px] text-dim">USDC</span>
          </div>

          <button
            className="cta cta-primary w-full h-10 text-[13px]"
            disabled={
              !!busy ||
              (mode === "deposit"
                ? !anqa.sessionKp || wallet <= 0 || !anqa.privateRpcReady
                : account <= 0)
            }
            onClick={mode === "deposit" ? doDeposit : doWithdraw}
          >
            {busy
              ? `${busy}…`
              : mode === "deposit"
                ? depositLabel
                : account <= 0
                  ? "Nothing to withdraw"
                  : "Withdraw"}
          </button>

          <div className="flex items-center justify-between pt-1 border-t border-line-soft">
            <p className="text-[10px] text-dim leading-relaxed max-w-[70%]">
              One account, every market. Each position risks only the collateral you commit to it.
            </p>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={faucet}>
              Get test USDC
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
