"use client";

import dynamic from "next/dynamic";
import { Badge } from "./ui";
import { Wordmark } from "./Wordmark";
import type { Anqa } from "@/lib/useAnqa";

// The wallet button reaches for browser APIs; keep it off the server render.
const WalletButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);

export function Header({ anqa }: { anqa: Anqa }) {
  const mark = anqa.markPrice;
  const priced = mark !== null && mark > 0;

  return (
    <header className="shrink-0 flex items-center gap-5 h-14 px-4 border-b border-line-soft bg-ink">
      <Wordmark />

      <div className="h-6 w-px bg-line-soft" />

      <div className="flex items-baseline gap-3">
        <span className="text-[13px] font-medium text-bright tracking-wide">
          BTC-PERP
        </span>
        <span className="tnum text-[17px] font-medium text-phoenix">
          {priced
            ? (mark / 1e6).toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })
            : "—"}
        </span>
      </div>

      <div className="flex items-center gap-2">
        {anqa.market?.dark && <Badge tone="dark">dark</Badge>}
        {anqa.delegated ? (
          <Badge tone="live">
            <span className="live-dot w-1.5 h-1.5 rounded-full bg-bid inline-block" />
            rollup
          </Badge>
        ) : (
          <Badge tone="neutral">base</Badge>
        )}
        {anqa.market?.paused && <Badge tone="warn">paused</Badge>}
      </div>

      <p className="hidden lg:block ml-auto text-[11px] text-dim italic">
        known by name, unseen by eye
      </p>

      <div className={anqa.market?.dark ? "" : "ml-auto lg:ml-0"}>
        <WalletButton />
      </div>
    </header>
  );
}
