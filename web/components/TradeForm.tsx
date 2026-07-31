"use client";

import { useMemo, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import dynamic from "next/dynamic";
import { Badge, Button } from "./ui";
import { readableError } from "@/lib/anqa";
import {
  claimDeposit,
  delegatePortfolio,
  deposit,
  openAccount,
  permissionPortfolio,
  placeOrder,
} from "@/lib/actions";
import { usd, usdToTicks } from "@/lib/anqa";
import { freeMargin, readKernel } from "@/lib/portfolio";
import type { Anqa } from "@/lib/useAnqa";

const WalletButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);

const MINT = process.env.NEXT_PUBLIC_COLLATERAL_MINT
  ? new PublicKey(process.env.NEXT_PUBLIC_COLLATERAL_MINT)
  : null;

const INITIAL_MARGIN_BPS = 500; // 20x — mirrors the on-chain constant

/**
 * The order ticket.
 *
 * It doubles as the onboarding path, because on this venue they are the same
 * sequence: an account, collateral, and a session in the rollup are all
 * preconditions for an order, and hiding them behind a separate screen only
 * makes the first order fail for reasons the trader cannot see. So the button
 * always says the next true thing.
 */
export function TradeForm({
  anqa,
  onDone,
}: {
  anqa: Anqa;
  onDone: (msg: string, err?: boolean) => void;
}) {
  const [side, setSide] = useState<"bid" | "ask">("bid");
  const [type, setType] = useState<"limit" | "market">("limit");
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");
  const [postOnly, setPostOnly] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const owner = anqa.wallet?.publicKey;
  const tick = anqa.market?.tickSize ?? 1;
  const mark = anqa.markPrice === null ? null : anqa.markPrice / 1e6;
  const kernel = useMemo(
    () => (anqa.portfolio ? readKernel(anqa.portfolio.inner) : null),
    [anqa.portfolio]
  );
  const reserved = anqa.portfolio
    ? BigInt(new BN(anqa.portfolio.reservedMargin, 10, "le").toString())
    : 0n;
  const free = kernel ? freeMargin(kernel, reserved) : 0n;

  const effPrice = type === "market" ? mark ?? 0 : Number(price) || mark || 0;
  const lots = Number(size) || 0;
  const notional = effPrice * lots;
  const margin = (notional * INITIAL_MARGIN_BPS) / 10_000;

  const ctx = () => ({
    acc: anqa.acc,
    marketId: anqa.marketId,
    owner: owner!,
    engine: owner!,
  });

  const run = async (label: string, layer: "base" | "er", fn: (p: any, c: any) => Promise<any>) => {
    const p = anqa.programFor(layer);
    if (!p || !owner) return;
    setBusy(label);
    try {
      await fn(p, ctx());
      onDone(`${label} done`);
      anqa.refresh();
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
      anqa.refresh();
    } catch (e: any) {
      onDone(readableError(e), true);
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    const p = anqa.programFor("er");
    if (!p || !owner) return;
    if (!lots) return onDone("Size is required", true);
    if (type === "limit" && !Number(price)) return onDone("Price is required", true);
    // A market order still needs a bound; cross the band, not the universe.
    const limit = type === "market" ? (side === "bid" ? effPrice * 1.02 : effPrice * 0.98) : Number(price);
    setBusy("Order");
    try {
      await placeOrder(p, ctx(), {
        side,
        orderType: type === "market" ? "immediateOrCancel" : postOnly ? "postOnly" : "limit",
        priceInTicks: new BN(usdToTicks(limit, tick)),
        baseLots: new BN(lots),
        clientOrderId: new BN(Date.now() % 2_000_000_000),
        makers: [], // dark: name nobody
      });
      onDone(anqa.market?.dark ? "Order submitted — hidden" : "Order submitted");
      setSize("");
      anqa.refresh();
    } catch (e: any) {
      onDone(readableError(e), true);
    } finally {
      setBusy(null);
    }
  };

  // The next true thing, in the order the protocol requires it.
  const step = !anqa.wallet
    ? "connect"
    : !anqa.portfolio
      ? "open"
      : (anqa.ledger?.deposited ?? 0) == 0
        ? "fund"
        : !anqa.portfolioDelegated
          ? "session"
          : kernel && kernel.capital === 0n
            ? "claim"
            : "trade";

  return (
    <section className="flex flex-col min-h-0 bg-ink border border-line-soft rounded-lg overflow-hidden">
      <header className="flex items-center shrink-0 h-9 px-2 border-b border-line-soft">
        <span className="text-[11px] uppercase tracking-[0.12em] text-dim px-1">Isolated</span>
        <div className="ml-auto">
          {anqa.portfolioDelegated ? (
            <Badge tone="live">
              <span className="live-dot w-1.5 h-1.5 rounded-full bg-bid inline-block" />
              session
            </Badge>
          ) : (
            <Badge tone="neutral">{anqa.portfolio ? "on base" : "no account"}</Badge>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto p-2.5 flex flex-col gap-2.5">
        {/* side */}
        <div className="grid grid-cols-2 gap-1.5">
          <Button variant={side === "bid" ? "bid" : "default"} onClick={() => setSide("bid")}>
            Long / Buy
          </Button>
          <Button variant={side === "ask" ? "ask" : "default"} onClick={() => setSide("ask")}>
            Short / Sell
          </Button>
        </div>

        {/* order type */}
        <div className="flex items-center gap-1 border-b border-line-soft">
          {(["limit", "market"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`h-7 px-2.5 text-[11px] font-medium capitalize border-b-2 -mb-px transition-colors ${
                type === t ? "border-phoenix text-bright" : "border-transparent text-dim hover:text-text"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <Row label="Limit price" suffix="USDC">
          <input
            value={type === "market" ? "" : price}
            onChange={(e) => setPrice(e.target.value)}
            disabled={type === "market"}
            placeholder={type === "market" ? "market" : mark?.toFixed(2) ?? "0.00"}
            inputMode="decimal"
            className="tnum w-full bg-transparent text-right text-[12px] text-bright outline-none placeholder:text-dim/60 disabled:opacity-50"
          />
        </Row>
        {mark !== null && type === "limit" && (
          <button
            onClick={() => setPrice(mark.toFixed(2))}
            className="text-[10px] text-dim hover:text-phoenix transition-colors text-left -mt-1"
          >
            use mark {mark.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </button>
        )}

        <Row label="Size" suffix="lots">
          <input
            value={size}
            onChange={(e) => setSize(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            className="tnum w-full bg-transparent text-right text-[12px] text-bright outline-none placeholder:text-dim/60"
          />
        </Row>

        <div className="flex flex-col gap-1 py-1.5 border-y border-line-soft">
          <Line label="Order value" value={notional ? `$${notional.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"} />
          <Line label="Margin required" value={margin ? `$${margin.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"} />
          <Line label="Free margin" value={kernel ? `$${usd(free.toString())}` : "—"} />
        </div>

        <label className="flex items-center gap-2 text-[11px] text-muted select-none cursor-pointer">
          <input
            type="checkbox"
            checked={postOnly}
            disabled={type === "market"}
            onChange={(e) => setPostOnly(e.target.checked)}
            className="accent-[color:var(--color-phoenix)]"
          />
          Post only — never take
        </label>

        {/* the next true action */}
        <div className="mt-auto pt-1 flex flex-col gap-1.5">
          {step === "connect" && <WalletButton />}

          {step === "open" && (
            <Button variant="primary" disabled={!!busy} onClick={() => run("Open account", "base", openAccount)}>
              {busy ? "Opening…" : "Open account"}
            </Button>
          )}

          {step === "fund" && (
            <>
              <div className="flex gap-1.5">
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  inputMode="decimal"
                  className="tnum flex-1 min-w-0 h-9 bg-void border border-line rounded-md px-2 text-[12px] text-bright outline-none focus:border-phoenix-soft placeholder:text-dim/60"
                />
                <Button
                  variant="primary"
                  disabled={!!busy || !MINT}
                  onClick={() => {
                    const n = Number(amount);
                    if (!n || !MINT) return onDone("Amount required", true);
                    run("Deposit", "base", (p, c) => deposit(p, c, MINT, new BN(Math.round(n * 1e6))));
                    setAmount("");
                  }}
                >
                  Deposit
                </Button>
              </div>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={faucet}>
                {busy === "Faucet" ? "…" : "Get test USDC"}
              </Button>
            </>
          )}

          {step === "session" && (
            <>
              <Button variant="primary" disabled={!!busy} onClick={() => run("Start session", "base", delegatePortfolio)}>
                {busy === "Start session" ? "Starting…" : "Start session"}
              </Button>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run("Make private", "base", permissionPortfolio)}>
                Make private
              </Button>
            </>
          )}

          {step === "claim" && (
            <Button variant="primary" disabled={!!busy} onClick={() => run("Claim", "er", claimDeposit)}>
              {busy ? "Claiming…" : "Claim collateral into rollup"}
            </Button>
          )}

          {step === "trade" && (
            <Button variant={side === "bid" ? "bid" : "ask"} disabled={!!busy} onClick={submit}>
              {busy === "Order"
                ? "Submitting…"
                : `${side === "bid" ? "Long" : "Short"}${anqa.market?.dark ? " — hidden" : ""}`}
            </Button>
          )}

          <p className="text-[10px] text-dim leading-relaxed">
            {step === "connect" && "Connect a wallet to trade."}
            {step === "open" && "Opens your margin account on base chain."}
            {step === "fund" && "Collateral is held on base and never enters the rollup."}
            {step === "session" && "Moves your account into the rollup for the session."}
            {step === "claim" && "Credits the deposit inside the rollup."}
            {step === "trade" &&
              (anqa.market?.dark
                ? "Your order names no counterparty. The engine settles the fill; only the price prints."
                : "Crosses the book directly.")}
          </p>
        </div>
      </div>
    </section>
  );
}

function Row({
  label,
  suffix,
  children,
}: {
  label: string;
  suffix?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 h-9 px-2.5 bg-void border border-line rounded-md focus-within:border-phoenix-soft transition-colors">
      <span className="text-[11px] text-dim whitespace-nowrap">{label}</span>
      {children}
      {suffix && <span className="text-[10px] text-dim">{suffix}</span>}
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[10px] text-dim">{label}</span>
      <span className="tnum text-[11px] text-text">{value}</span>
    </div>
  );
}
