"use client";

import { useEffect, useState } from "react";
import { Panel } from "./ui";
import { ER_RPC, shortKey } from "@/lib/anqa";
import type { Anqa } from "@/lib/useAnqa";

type Probe = { label: string; account: string; readable: boolean | null; note: string };

/**
 * The claim, checked live.
 *
 * Rather than asserting privacy in marketing copy, this panel asks the rollup
 * for each account as an anonymous reader and reports what came back. On a
 * TEE endpoint the book answers `null` and the tape answers with data — the
 * same query, two different outcomes, decided by the permission record. On
 * the public endpoint everything answers, and the panel says so instead of
 * pretending otherwise. A privacy product that lies in its own UI is worth
 * nothing.
 */
export function ProofPanel({ anqa }: { anqa: Anqa }) {
  const [probes, setProbes] = useState<Probe[]>([]);
  const isTee = ER_RPC.includes("tee");

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const targets = [
        { label: "the book", key: anqa.acc.book, note: "resting depth" },
        {
          label: "your account",
          key: anqa.wallet ? anqa.acc.portfolioOf(anqa.wallet.publicKey) : null,
          note: "positions & margin",
        },
        { label: "the tape", key: anqa.acc.tape, note: "public prints" },
      ];
      const out: Probe[] = [];
      for (const t of targets) {
        if (!t.key) continue;
        // An unauthenticated reader: no wallet, no membership, just an RPC.
        const info = await anqa.conns.er.getAccountInfo(t.key).catch(() => null);
        out.push({
          label: t.label,
          account: t.key.toBase58(),
          readable: info !== null,
          note: t.note,
        });
      }
      if (!cancelled) setProbes(out);
    };
    run();
    const t = setInterval(run, 6000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [anqa.acc, anqa.conns, anqa.wallet]);

  return (
    <Panel title="what a stranger sees" bodyClassName="flex flex-col">
      <div className="flex-1 divide-y divide-line-soft">
        {probes.map((p) => (
          <div key={p.account} className="flex items-center gap-3 px-3 py-2.5">
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-[12px] text-text">{p.label}</span>
                <span className="text-[10px] text-dim truncate">{p.note}</span>
              </div>
              <span className="tnum text-[10px] text-dim/70">
                {shortKey(p.account, 6)}
              </span>
            </div>
            {p.readable === null ? (
              <span className="text-[11px] text-dim">…</span>
            ) : p.readable ? (
              <span className="text-[11px] text-ask">readable</span>
            ) : (
              <span className="text-[11px] text-bid">refused</span>
            )}
          </div>
        ))}
      </div>

      <footer className="shrink-0 px-3 py-2 border-t border-line-soft">
        {isTee ? (
          <p className="text-[10px] text-dim leading-relaxed">
            Queried anonymously against the TEE validator. The book refuses;
            the tape answers. Same request, different reply — enforced by the
            enclave, not by this page.
          </p>
        ) : (
          <p className="text-[10px] text-dim leading-relaxed">
            This endpoint is the <span className="text-muted">public</span>{" "}
            rollup, which serves every account to everyone. Permission records
            exist on-chain and the dark settlement path is live; read-gating
            turns on against a TEE validator.
          </p>
        )}
      </footer>
    </Panel>
  );
}
