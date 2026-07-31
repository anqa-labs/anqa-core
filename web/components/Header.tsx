"use client";

import dynamic from "next/dynamic";
import { Wordmark } from "./Wordmark";
import type { Anqa } from "@/lib/useAnqa";

const WalletButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);

const NAV = ["Trade", "Portfolio", "Docs"] as const;

export function Header({ anqa }: { anqa: Anqa }) {
  return (
    <header className="shrink-0 flex items-center gap-6 h-14 px-4 border-b border-line-soft bg-ink">
      <Wordmark />

      <nav className="hidden md:flex items-center gap-1">
        {NAV.map((item, i) => (
          <span
            key={item}
            className={`h-8 px-3 grid place-items-center text-[13px] rounded-md ${
              i === 0 ? "text-bright" : "text-dim"
            }`}
          >
            {item}
          </span>
        ))}
      </nav>

      <p className="hidden xl:block ml-auto text-[11px] text-dim italic">
        known by name, unseen by eye
      </p>

      <div className={anqa.market ? "" : "ml-auto"}>
        <WalletButton />
      </div>
    </header>
  );
}
