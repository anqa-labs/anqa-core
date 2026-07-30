"use client";

import { useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { Button, Field, Panel } from "./ui";
import { placeOrder } from "@/lib/actions";
import { usdToTicks } from "@/lib/anqa";
import type { Anqa } from "@/lib/useAnqa";

/**
 * Order entry.
 *
 * The one thing worth noticing: on a dark market this form sends **no
 * counterparty accounts**. The trader cannot see whom they are about to
 * cross, so the fill queues on the book and the engine settles it — the
 * difference between a lit venue and this one, expressed as an absence.
 */
export function OrderEntry({
  anqa,
  onDone,
}: {
  anqa: Anqa;
  onDone: (msg: string, err?: boolean) => void;
}) {
  const [side, setSide] = useState<"bid" | "ask">("bid");
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");
  const [postOnly, setPostOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  const tick = anqa.market?.tickSize ?? 1;
  const mark = anqa.markPrice;
  const ready = anqa.wallet && anqa.portfolio && anqa.delegated;

  const submit = async () => {
    const p = anqa.programFor("er");
    if (!p || !anqa.wallet) return;
    const priceNum = Number(price);
    const sizeNum = Number(size);
    if (!priceNum || !sizeNum) return onDone("Price and size are required", true);

    setBusy(true);
    try {
      await placeOrder(
        p,
        {
          acc: anqa.acc,
          marketId: anqa.marketId,
          owner: anqa.wallet.publicKey,
          engine: anqa.wallet.publicKey,
        },
        {
          side,
          orderType: postOnly ? "postOnly" : "limit",
          priceInTicks: new BN(usdToTicks(priceNum, tick)),
          baseLots: new BN(sizeNum),
          clientOrderId: new BN(Date.now() % 2_000_000_000),
          // Dark: name nobody. Lit: the taker would pass the makers it read.
          makers: [],
        }
      );
      onDone(
        anqa.market?.dark
          ? `${side === "bid" ? "Buy" : "Sell"} submitted — hidden`
          : `${side === "bid" ? "Buy" : "Sell"} submitted`
      );
      setSize("");
      anqa.refresh();
    } catch (e: any) {
      onDone(readableError(e), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="order" bodyClassName="p-3 flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-1.5">
        <Button
          variant={side === "bid" ? "bid" : "default"}
          onClick={() => setSide("bid")}
        >
          Buy
        </Button>
        <Button
          variant={side === "ask" ? "ask" : "default"}
          onClick={() => setSide("ask")}
        >
          Sell
        </Button>
      </div>

      <Field
        label="price"
        value={price}
        onChange={setPrice}
        placeholder={mark ? (mark / 1e6).toFixed(2) : "0.00"}
        suffix="USDC"
      />
      <Field
        label="size"
        value={size}
        onChange={setSize}
        placeholder="0"
        suffix="lots"
      />

      <label className="flex items-center gap-2 text-[11px] text-muted select-none cursor-pointer">
        <input
          type="checkbox"
          checked={postOnly}
          onChange={(e) => setPostOnly(e.target.checked)}
          className="accent-[color:var(--color-phoenix)]"
        />
        post only — never take
      </label>

      {mark !== null && (
        <button
          onClick={() => setPrice((mark / 1e6).toFixed(2))}
          className="text-[10px] text-dim hover:text-phoenix transition-colors text-left"
        >
          use mark {(mark / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </button>
      )}

      <Button
        variant={side === "bid" ? "bid" : "ask"}
        onClick={submit}
        disabled={!ready || busy}
        className="mt-auto"
      >
        {busy
          ? "Submitting…"
          : side === "bid"
            ? "Buy — hidden"
            : "Sell — hidden"}
      </Button>

      {!ready && (
        <p className="text-[10px] text-dim leading-relaxed">
          {!anqa.wallet
            ? "Connect a wallet to trade."
            : !anqa.portfolio
              ? "Open an account first."
              : "Start a session to place orders."}
        </p>
      )}
    </Panel>
  );
}

/** Anchor errors are verbose; the trader wants the sentence, not the stack. */
export function readableError(e: any): string {
  const msg = String(e?.message ?? e);
  const anchor = e?.error?.errorMessage ?? e?.errorMessage;
  if (anchor) return anchor;
  const m = msg.match(/Error Message: ([^.]+)\./);
  if (m) return m[1];
  if (msg.includes("User rejected")) return "Rejected in wallet";
  return msg.length > 120 ? msg.slice(0, 120) + "…" : msg;
}
