"use client";

import { useCallback, useEffect, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Badge, Button, Empty, Panel, Stat } from "./ui";
import { readableError } from "./OrderEntry";
import {
  authorizeWithdraw,
  cancelAll,
  cancelOrder,
  claimDeposit,
  delegatePortfolio,
  deposit,
  openAccount,
  permissionPortfolio,
  requestWithdraw,
  settleWithdraw,
  undelegatePortfolio,
} from "@/lib/actions";
import { ticksToUsd, usd } from "@/lib/anqa";
import type { Anqa } from "@/lib/useAnqa";

const MINT = process.env.NEXT_PUBLIC_COLLATERAL_MINT
  ? new PublicKey(process.env.NEXT_PUBLIC_COLLATERAL_MINT)
  : null;

/**
 * Account, funding, and the session.
 *
 * "Session" is the honest word for delegation: the trader decides when their
 * account is inside the rollup and when it comes home. Nothing is parked
 * there by default, and there is always a committed state on base to exit
 * against — which is what makes the venue non-custodial rather than merely
 * well-behaved.
 */
export function AccountPanel({
  anqa,
  onDone,
}: {
  anqa: Anqa;
  onDone: (msg: string, err?: boolean) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [walletUsdc, setWalletUsdc] = useState<number | null>(null);
  const owner = anqa.wallet?.publicKey;

  const refreshWallet = useCallback(async () => {
    if (!owner || !MINT) return setWalletUsdc(null);
    try {
      const ata = getAssociatedTokenAddressSync(MINT, owner);
      const bal = await anqa.conns.base.getTokenAccountBalance(ata);
      setWalletUsdc(Number(bal.value.amount));
    } catch {
      setWalletUsdc(0);
    }
  }, [anqa.conns, owner]);

  useEffect(() => {
    refreshWallet();
    const t = setInterval(refreshWallet, 5000);
    return () => clearInterval(t);
  }, [refreshWallet]);

  const run = async (
    label: string,
    layer: "base" | "er",
    fn: (p: any, c: any) => Promise<any>
  ) => {
    const p = anqa.programFor(layer);
    if (!p || !owner) return;
    setBusy(label);
    try {
      await fn(p, { acc: anqa.acc, marketId: anqa.marketId, owner, engine: owner });
      onDone(`${label} done`);
      anqa.refresh();
      refreshWallet();
    } catch (e: any) {
      onDone(readableError(e), true);
    } finally {
      setBusy(null);
    }
  };

  const faucet = async () => {
    if (!owner) return;
    setBusy("Faucet");
    try {
      const r = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: owner.toBase58() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Faucet failed");
      onDone(`${j.amount.toLocaleString()} test USDC sent`);
      refreshWallet();
    } catch (e: any) {
      onDone(readableError(e), true);
    } finally {
      setBusy(null);
    }
  };

  const fund = () => {
    const n = Number(amount);
    if (!n || !MINT) return onDone("Amount required", true);
    run("Deposit", "base", (p, c) => deposit(p, c, MINT, new BN(Math.round(n * 1e6))));
    setAmount("");
  };

  /** Withdrawal is three legs across two layers; drive them in order. */
  const exit = async () => {
    const n = Number(amount);
    if (!n || !MINT || !owner) return onDone("Amount required", true);
    const base = anqa.programFor("base");
    const er = anqa.programFor("er");
    if (!base || !er) return;
    const c = { acc: anqa.acc, marketId: anqa.marketId, owner, engine: owner };
    setBusy("Withdraw");
    try {
      await requestWithdraw(base, c, MINT, new BN(Math.round(n * 1e6)));
      onDone("Requested — the kernel is judging it");
      await authorizeWithdraw(er, c);
      onDone("Authorized — the receipt is coming home");
      // The receipt must undelegate before base can consume it. That takes
      // roughly a hundred seconds on the shared validator.
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const info = await anqa.conns.base.getAccountInfo(
          anqa.acc.withdrawReceiptOf(owner)
        );
        if (!info) break; // settled and closed by the validator's action
        if (info.owner.equals(base.programId)) {
          await settleWithdraw(base, c, MINT);
          break;
        }
      }
      onDone("Withdrawn");
      anqa.refresh();
      refreshWallet();
      setAmount("");
    } catch (e: any) {
      onDone(readableError(e), true);
    } finally {
      setBusy(null);
    }
  };

  const deposited = anqa.ledger ? Number(anqa.ledger.deposited.toString()) : 0;
  const tick = anqa.market?.tickSize ?? 1;
  const myOrders = [
    ...anqa.myBids.map((o) => ({ ...o, side: "bid" as const })),
    ...anqa.myAsks.map((o) => ({ ...o, side: "ask" as const })),
  ];

  if (!anqa.wallet) {
    return (
      <Panel title="account">
        <Empty>Connect a wallet to see your side of the book.</Empty>
      </Panel>
    );
  }

  return (
    <Panel
      title="account"
      right={
        anqa.delegated ? (
          <Badge tone="live">
            <span className="live-dot w-1.5 h-1.5 rounded-full bg-bid inline-block" />
            in session
          </Badge>
        ) : (
          <Badge tone="neutral">on base</Badge>
        )
      }
      bodyClassName="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] overflow-hidden"
    >
      {/* funding */}
      <div className="flex flex-col gap-2.5 p-3 md:border-r border-line-soft overflow-y-auto">
        <div className="grid grid-cols-2 gap-3">
          <Stat label="in wallet" value={usd(walletUsdc ?? 0)} hint="test USDC" />
          <Stat label="in vault" value={usd(deposited)} hint="collateral on base" />
        </div>

        <div className="flex gap-1.5">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
            className="tnum flex-1 min-w-0 h-7 bg-void border border-line rounded px-2 text-[12px]
                       text-bright outline-none focus:border-phoenix-soft placeholder:text-dim/60"
          />
          <Button size="sm" disabled={!!busy || !anqa.portfolio} onClick={fund}>
            Deposit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy || !anqa.portfolio}
            onClick={exit}
          >
            Withdraw
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {!anqa.portfolio ? (
            <Button
              size="sm"
              variant="primary"
              disabled={!!busy}
              onClick={() => run("Open account", "base", openAccount)}
            >
              {busy === "Open account" ? "Opening…" : "Open account"}
            </Button>
          ) : (
            <>
              {anqa.delegated ? (
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!!busy}
                    onClick={() => run("Claim", "er", claimDeposit)}
                  >
                    Claim into rollup
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!!busy}
                    onClick={() => run("End session", "er", undelegatePortfolio)}
                  >
                    End session
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!!busy}
                    onClick={() => run("Start session", "base", delegatePortfolio)}
                  >
                    {busy === "Start session" ? "Starting…" : "Start session"}
                  </Button>
                  <Button
                    size="sm"
                    disabled={!!busy}
                    onClick={() => run("Make private", "base", permissionPortfolio)}
                  >
                    Make private
                  </Button>
                </>
              )}
            </>
          )}
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={faucet}>
            {busy === "Faucet" ? "…" : "Get test USDC"}
          </Button>
        </div>

        {busy === "Withdraw" && (
          <p className="text-[10px] text-phoenix/80 leading-relaxed">
            Crossing the boundary: the rollup decides, the receipt commits home,
            base pays out. About two minutes on the shared validator.
          </p>
        )}
      </div>

      {/* resting orders */}
      <div className="flex flex-col min-h-0 overflow-hidden">
        <div className="flex items-center justify-between shrink-0 px-3 h-8 border-b border-line-soft">
          <span className="text-[10px] uppercase tracking-[0.12em] text-dim">
            your orders
          </span>
          {myOrders.length > 0 && (
            <button
              onClick={() => run("Cancel all", "er", cancelAll)}
              disabled={!!busy}
              className="text-[10px] text-dim hover:text-ask transition-colors disabled:opacity-40"
            >
              cancel all
            </button>
          )}
        </div>

        {myOrders.length === 0 ? (
          <Empty>No resting orders.</Empty>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto">
            {myOrders.map((o, i) => (
              <div
                key={i}
                className="group flex items-center justify-between px-3 py-[6px] text-[12px] hover:bg-surface/60"
              >
                <span
                  className={`w-9 text-[10px] uppercase tracking-wide ${
                    o.side === "bid" ? "text-bid" : "text-ask"
                  }`}
                >
                  {o.side === "bid" ? "buy" : "sell"}
                </span>
                <span className="tnum flex-1 text-text">
                  {ticksToUsd(o.priceInTicks, tick).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                  })}
                </span>
                <span className="tnum text-muted mr-3">{o.baseLots.toString()}</span>
                <button
                  onClick={() =>
                    run("Cancel", "er", (p, c) =>
                      cancelOrder(p, c, o.side, o.clientOrderId)
                    )
                  }
                  disabled={!!busy}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-dim hover:text-ask"
                >
                  cancel
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
