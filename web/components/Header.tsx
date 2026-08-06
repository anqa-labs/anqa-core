"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Wordmark } from "./Wordmark";
import { readKernel, equity } from "@/lib/portfolio";
import { useAllPositions } from "@/lib/useAllPositions";
import type { Anqa } from "@/lib/useAnqa";

const WalletButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);

export function Header({ anqa, onDeposit }: { anqa: Anqa; onDeposit: () => void }) {
  // The trader's free balance — total equity minus the collateral already
  // committed to open positions, which is what they can still trade with.
  const positions = useAllPositions();
  const equityUsd = anqa.portfolio
    ? Number(equity(readKernel(anqa.portfolio.inner))) / 1e6
    : 0;
  const committed = positions.reduce((a, r) => a + (r.legMarginUsd ?? 0), 0);
  const balance = Math.max(0, equityUsd - committed);
  return (
    <header className="shrink-0 flex items-center gap-6 h-14 px-4 border-b border-line-soft bg-ink">
      <Link href="/" aria-label="Anqa home">
        <Wordmark />
      </Link>

      <nav className="hidden md:flex items-center gap-0.5">
        <Link
          href="/trade"
          className="relative grid h-8 place-items-center rounded-md px-3 text-[13px] text-bright after:absolute after:-bottom-[13px] after:left-3 after:right-3 after:h-[2px] after:rounded-full after:bg-phoenix"
        >
          Trade
        </Link>
        <span className="relative grid h-8 cursor-default place-items-center rounded-md px-3 text-[13px] text-dim">
          Portfolio
        </span>
        <Link
          href="/docs"
          className="relative grid h-8 place-items-center rounded-md px-3 text-[13px] text-dim transition-colors hover:text-text"
        >
          Docs
        </Link>
      </nav>

      <p className="hidden xl:block ml-auto text-[11px] text-dim italic">
        known by name, unseen by eye
      </p>

      <div className={`flex items-center gap-2 ${anqa.market ? "" : "ml-auto"}`}>
        {anqa.wallet && (
          <>
            <button
              onClick={onDeposit}
              className="h-9 px-3.5 flex items-center gap-1.5 rounded-lg border border-phoenix/40 text-[13px] font-medium text-phoenix hover:bg-phoenix/10 transition-colors"
            >
              <span className="text-[11px]">↓</span> Deposit
            </button>
            <button
              onClick={onDeposit}
              className="tnum h-9 px-3 rounded-lg bg-void border border-line text-[13px] text-bright hover:border-line-soft transition-colors"
              title="Your trading account — funds every market"
            >
              ${balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </button>
          </>
        )}
        <WalletButton />
      </div>
    </header>
  );
}
