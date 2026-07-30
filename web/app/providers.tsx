"use client";

import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { BASE_RPC } from "@/lib/anqa";

/**
 * The wallet talks to **base chain** — that is where a trader signs custody
 * moves. Rollup transactions are built and sent by the terminal against the
 * ER endpoint, signed by the same wallet; see `useAnqa`.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  // Wallet Standard discovers installed wallets on its own; naming adapters
  // here would only duplicate them.
  const wallets = useMemo(() => [], []);

  return (
    <ConnectionProvider endpoint={BASE_RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
