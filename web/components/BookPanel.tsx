"use client";

import { Badge, Empty, Panel } from "./ui";
import { ticksToUsd } from "@/lib/anqa";
import type { Anqa } from "@/lib/useAnqa";

/**
 * The book, as *you* are allowed to see it.
 *
 * This panel is the product in one view: your own resting orders in full
 * detail, and everyone else's as depth without detail — rows you can count
 * but never read. On a TEE validator that is literally all the venue will
 * serve you; here it is drawn that way on purpose, because a terminal that
 * showed you other people's orders would be advertising the opposite of what
 * anqa sells.
 */
export function BookPanel({ anqa }: { anqa: Anqa }) {
  const tick = anqa.market?.tickSize ?? 1;
  const px = (t: number | { toString(): string }) => ticksToUsd(Number(t.toString()), tick);

  const asks = [...anqa.myAsks].sort(
    (a, b) => Number(b.priceInTicks.toString()) - Number(a.priceInTicks.toString())
  );
  const bids = [...anqa.myBids].sort(
    (a, b) => Number(b.priceInTicks.toString()) - Number(a.priceInTicks.toString())
  );
  const nothing =
    asks.length === 0 &&
    bids.length === 0 &&
    anqa.hiddenAsks === 0 &&
    anqa.hiddenBids === 0;

  return (
    <Panel
      title="book"
      right={
        <Badge tone={anqa.market?.dark ? "dark" : "neutral"}>
          {anqa.market?.dark ? "hidden" : "lit"}
        </Badge>
      }
      bodyClassName="flex flex-col overflow-hidden"
    >
      <div className="grid grid-cols-[1fr_auto_auto] px-3 py-1.5 text-[10px] uppercase tracking-[0.1em] text-dim border-b border-line-soft">
        <span>price</span>
        <span className="text-right pr-3">size</span>
        <span className="text-right w-14">who</span>
      </div>

      {nothing ? (
        <Empty>
          No depth yet. Rest an order and it appears here — to you, and to
          nobody else.
        </Empty>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <Side rows={asks} hidden={anqa.hiddenAsks} side="ask" px={px} />
          <Mark anqa={anqa} />
          <Side rows={bids} hidden={anqa.hiddenBids} side="bid" px={px} />
        </div>
      )}
    </Panel>
  );
}

function Side({
  rows,
  hidden,
  side,
  px,
}: {
  rows: any[];
  hidden: number;
  side: "bid" | "ask";
  px: (t: any) => number;
}) {
  const tone = side === "bid" ? "text-bid" : "text-ask";
  // Veiled rows stand in for depth that exists and cannot be read. Cap the
  // drawn rows so a deep book does not become a wall of hatching.
  const veils = Math.min(hidden, 6);
  const veilRows = Array.from({ length: veils });
  const body = (
    <>
      {rows.map((o, i) => (
        <div
          key={`${side}-${i}`}
          className="grid grid-cols-[1fr_auto_auto] px-3 py-[5px] text-[12px] hover:bg-surface/60"
        >
          <span className={`tnum ${tone}`}>
            {px(o.priceInTicks).toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </span>
          <span className="tnum text-right pr-3 text-text">
            {o.baseLots.toString()}
          </span>
          <span className="text-right w-14 text-[10px] text-phoenix/80">you</span>
        </div>
      ))}
      {veilRows.map((_, i) => (
        <div
          key={`${side}-veil-${i}`}
          className="grid grid-cols-[1fr_auto_auto] items-center px-3 py-[5px]"
          title="Resting depth you are not permitted to read"
        >
          <span className="veil h-3 rounded-sm mr-6 opacity-45" />
          <span className="veil h-3 w-10 rounded-sm mr-3 opacity-45" />
          <span className="text-right w-14 text-[10px] text-dim">—</span>
        </div>
      ))}
    </>
  );

  return (
    <div className={side === "ask" ? "flex flex-col-reverse" : ""}>
      {body}
      {hidden > veils && (
        <div className="px-3 py-1 text-[10px] text-dim">
          +{hidden - veils} more hidden
        </div>
      )}
    </div>
  );
}

function Mark({ anqa }: { anqa: Anqa }) {
  const mark = anqa.markPrice;
  return (
    <div className="flex items-center justify-between px-3 py-2 my-0.5 border-y border-line-soft bg-surface/40">
      <span className="text-[10px] uppercase tracking-[0.12em] text-dim">mark</span>
      <span className="tnum text-[14px] font-medium text-phoenix">
        {mark === null
          ? "—"
          : (mark / 1e6).toLocaleString(undefined, { minimumFractionDigits: 2 })}
      </span>
    </div>
  );
}
