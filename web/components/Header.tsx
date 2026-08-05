"use client";

import dynamic from "next/dynamic";
import { Wordmark } from "./Wordmark";
import { readKernel, equity } from "@/lib/portfolio";
import { useAllPositions } from "@/lib/useAllPositions";
import type { Anqa } from "@/lib/useAnqa";

const WalletButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);

const NAV = ["Trade", "Portfolio", "Docs"] as const;

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
      <Wordmark />

      <nav className="hidden md:flex items-center gap-0.5">
        {NAV.map((item, i) =>
          item === "Docs" ? (
            <a
              key={item}
              href="/docs"
              className="relative h-8 px-3 grid place-items-center text-[13px] rounded-md text-dim hover:text-text transition-colors"
            >
              {item}
            </a>
          ) : (
            <span
              key={item}
              className={`relative h-8 px-3 grid place-items-center text-[13px] rounded-md transition-colors ${
                i === 0
                  ? "text-bright after:absolute after:left-3 after:right-3 after:-bottom-[13px] after:h-[2px] after:rounded-full after:bg-phoenix"
                  : "text-dim hover:text-text cursor-default"
              }`}
            >
              {item}
            </span>
          )
        )}
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
