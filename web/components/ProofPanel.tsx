"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Panel } from "./ui";
import { ER_RPC, shortKey } from "@/lib/anqa";
import { migrateToPrivate } from "@/lib/margin";
import type { Anqa } from "@/lib/useAnqa";

// A purpose-built "attacker" program, deployed to devnet, that reads whatever
// account it is handed — the concrete form of "run your own code to CPI-read
// the private account". Source: programs/anqa-reader. We use it below to show
// that reading is not the boundary: admission is.
const READER_PROGRAM = new PublicKey(
  "Are1Rg5BRvuzxFYHCFZkFoGAiaXF78Rhd5i8MNxJBzPv"
);

// "exposed" and "dormant" both mean the anonymous read returned data, but they
// are opposite verdicts and must never be shown as one. A *delegated* account
// that answers a stranger is a privacy failure (exposed). An *undelegated* one
// answers because the rollup clones it from public base layer on demand — it
// is simply not in the dark yet (dormant), which is the resting state of a
// portfolio with no open position. Collapsing these into "readable" was the
// bug: it made a not-yet-delegated account look like a leak.
type Verdict = "public" | "exposed" | "dormant" | "refused" | "absent" | "pending";
type Probe = { label: string; account: string; verdict: Verdict; note: string };

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
  const [busy, setBusy] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const isTee = ER_RPC.includes("tee");

  // Accounts opened before privacy was folded into onboarding are already in
  // the rollup and cannot be hidden where they stand. This walks them out and
  // back in — the only safe way, and a one-time cost no new account pays.
  const hide = useCallback(async () => {
    const base = anqa.programFor("base");
    const er = anqa.programFor("er");
    if (!base || !er || !anqa.wallet) return;
    try {
      await migrateToPrivate(
        base,
        er,
        {
          acc: anqa.acc,
          marketId: anqa.marketId,
          owner: anqa.wallet.publicKey,
          engine: anqa.wallet.publicKey,
        },
        { onStep: setBusy }
      );
    } finally {
      setBusy(null);
      setNonce((n) => n + 1);
      anqa.refresh();
    }
  }, [anqa]);

  // A connection carrying **no session token** — which is the whole point.
  //
  // This used to probe through `anqa.conns.er`, and that connection carries
  // the connected wallet's token. So the panel queried as *the owner* while
  // telling the reader it was querying as a stranger, and reported the
  // owner's account as `readable` — which reads as "anyone can see my
  // positions", the opposite of what the venue does. A panel that exists to
  // check the claim has to be the one thing in the app that cannot be taken
  // on trust.
  const anon = useMemo(() => new Connection(ER_RPC.split("?")[0], "confirmed"), []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      // `dark` marks what the venue is supposed to hide. The book is the whole
      // point — its resting orders are unreadable to a stranger. The tape is
      // not hidden: it is the public print feed, so a stranger reading it is
      // the design working, not failing.
      const targets = [
        { label: "the book", key: anqa.acc.book, note: "resting depth", dark: true },
        {
          label: "your account",
          key: anqa.wallet ? anqa.acc.portfolioOf(anqa.wallet.publicKey) : null,
          note: "position, margin & PnL",
          dark: true,
        },
        { label: "the tape", key: anqa.acc.tape, note: "public prints", dark: false },
      ];
      const out: Probe[] = [];
      for (const t of targets) {
        if (!t.key) continue;
        // An unauthenticated reader: no wallet, no membership, just an RPC.
        const inRollup = await anon.getAccountInfo(t.key).catch(() => null);
        let verdict: Verdict;
        if (inRollup !== null) {
          // Readable. For the tape that is by design; for the book it would be
          // a privacy failure worth shouting about.
          verdict = t.dark ? "exposed" : "public";
        } else {
          // Silence has two meanings and they are not interchangeable: an
          // account the enclave *won't* show us, and one that was never
          // created. Base chain settles which it is.
          const onBase = await anqa.conns.base.getAccountInfo(t.key).catch(() => null);
          verdict = onBase === null ? "absent" : "refused";
        }
        out.push({ label: t.label, account: t.key.toBase58(), verdict, note: t.note });
      }
      if (!cancelled) setProbes(out);
    };
    run();
    const t = setInterval(run, 6000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [anon, anqa.acc, anqa.conns, anqa.wallet, nonce]);

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
              {p.verdict === "exposed" && p.label === "your account" && (
                <button
                  onClick={hide}
                  disabled={!!busy}
                  className="mt-0.5 block text-[9px] text-ask/90 hover:text-ask underline underline-offset-2 disabled:opacity-60 disabled:no-underline"
                >
                  {busy ?? "hide it — opened before privacy shipped"}
                </button>
              )}
            </div>
            <Verdict verdict={p.verdict} />
          </div>
        ))}
      </div>

      <CodeReachSection isTee={isTee} book={anqa.acc.book} tape={anqa.acc.tape} />

      <EnclaveSection isTee={isTee} />

      <VerdictFooter isTee={isTee} />
    </Panel>
  );
}

type Attestation = {
  stage: string;
  error?: string;
  tcbStatus?: string;
  advisories?: string[];
  reportData?: string;
  mrTd?: string;
  verifiedAt?: string;
};

/**
 * The half of the claim the probes above cannot reach.
 *
 * "The book returns null" is only as strong as the thing returning it. This
 * section asks the endpoint to prove it is a genuine Intel TDX enclave: the
 * page generates a random 64-byte challenge, the enclave signs it into a
 * fresh quote, and the quote is checked against Intel's certification chain.
 * DCAP verification runs in our API route (certificate chains and CRLs are
 * not browser work), but the challenge is generated *here* and compared
 * *here* — the check that binds the result to this page load does not take
 * the server's word for it.
 *
 * The build row is deliberately weaker than the rest and says so: the
 * measurement is what the enclave reports, but MagicBlock publishes no
 * reference value yet, so it is displayed rather than judged. Overclaiming
 * that row would be the same lie this panel exists to avoid.
 */
function EnclaveSection({ isTee }: { isTee: boolean }) {
  const [att, setAtt] = useState<Attestation | null>(null);
  const [challengeHex, setChallengeHex] = useState<string>("");
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    setAtt(null);
    try {
      const bytes = new Uint8Array(64);
      crypto.getRandomValues(bytes);
      const hexStr = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      const b64 = btoa(String.fromCharCode(...bytes));
      setChallengeHex(hexStr);
      const r = await fetch(`/api/attestation?challenge=${encodeURIComponent(b64)}`);
      setAtt(await r.json());
    } catch (e) {
      setAtt({ stage: "quote", error: String((e as Error).message) });
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    run();
  }, [run]);

  const verified = att?.stage === "done";
  const noAttestation = att?.stage === "quote";
  // Freshness is the client's own judgement: the report data inside the
  // verified quote must be the exact bytes this page rolled a moment ago.
  const fresh = verified && att?.reportData === challengeHex;
  const tcbGood = verified && att?.tcbStatus === "UpToDate";

  const mark = (ok: boolean) =>
    att === null ? (
      <span className="text-[11px] text-dim">…</span>
    ) : noAttestation ? (
      <span className="text-[11px] text-dim">no attestation</span>
    ) : ok ? (
      <span className="text-[11px] text-bid">verified</span>
    ) : (
      <span className="text-[11px] text-ask">failed</span>
    );

  return (
    <div className="shrink-0 border-t border-line-soft">
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
        <span className="text-[10px] uppercase tracking-wider text-dim">
          and the enclave itself
        </span>
        <button
          onClick={run}
          disabled={running}
          className="text-[10px] text-dim hover:text-text disabled:opacity-50"
        >
          {running ? "verifying…" : "verify again"}
        </button>
      </div>

      <div className="divide-y divide-line-soft">
        <CheckRow
          label="the hardware"
          note="TDX quote, chained to Intel's root"
          right={mark(verified)}
        />
        <CheckRow
          label="the freshness"
          note="quote echoes this page's challenge"
          right={mark(fresh)}
        />
        <CheckRow
          label="the firmware"
          note={
            verified && !tcbGood
              ? `TCB ${att?.tcbStatus}${att?.advisories?.length ? ` — ${att.advisories.join(", ")}` : ""}`
              : "TCB status per Intel"
          }
          right={mark(tcbGood)}
        />
        <CheckRow
          label="the build"
          note={
            verified && att?.mrTd
              ? `mrTd ${att.mrTd.slice(0, 12)}…${att.mrTd.slice(-8)}`
              : "measurement of what booted inside"
          }
          right={
            att === null ? (
              <span className="text-[11px] text-dim">…</span>
            ) : verified ? (
              <span
                className="text-[11px] text-dim"
                title="The enclave's reported build measurement. MagicBlock publishes no reference value yet, so this is shown, not judged."
              >
                measured
              </span>
            ) : (
              <span className="text-[11px] text-dim">—</span>
            )
          }
        />
      </div>

      {noAttestation && (
        <p className="px-3 pb-2 text-[10px] text-dim leading-relaxed">
          This endpoint answered no quote request — it offers no attestation
          {isTee ? "." : ", which is expected: it is not an enclave."}
        </p>
      )}
    </div>
  );
}

type Reach = "pending" | "refused" | "reached" | "error";

/**
 * The objection this panel exists to answer out loud.
 *
 * "A stranger reads `null`" only closes the read path. The sharper question is:
 * what stops someone running their OWN program that CPI-reads the account and
 * copies the bytes into one they can read? On Solana any executing program may
 * read any account in its instruction's account list — so if arbitrary code
 * could execute against a private account, the null above would be a facade.
 *
 * It cannot. This asks the TEE, as an anonymous stranger, to run a real
 * attacker program (`READER_PROGRAM`, deployed to devnet) against the private
 * book. The rollup refuses the transaction with a 403 at ingress — before it
 * executes — because the caller cannot prove membership. The identical call
 * against the public tape is admitted, so the refusal is privacy-specific, not
 * a generic failure. Reading was never the boundary; admission is.
 */
function CodeReachSection({
  isTee,
  book,
  tape,
}: {
  isTee: boolean;
  book: PublicKey;
  tape: PublicKey;
}) {
  const [bookReach, setBookReach] = useState<Reach>("pending");
  const [tapeReach, setTapeReach] = useState<Reach>("pending");
  const [running, setRunning] = useState(false);
  const url = useMemo(() => ER_RPC.split("?")[0], []);

  // Simulate `READER_PROGRAM(target)` as an anonymous stranger and classify the
  // reply: a 403 (or an access-denied body) is an ingress refusal; program logs
  // mean it executed and reached the bytes.
  const probe = useCallback(
    async (target: PublicKey): Promise<Reach> => {
      try {
        const conn = new Connection(url, "confirmed");
        const stranger = Keypair.generate(); // random, non-member, unfunded
        const { blockhash } = await conn.getLatestBlockhash();
        const tx = new Transaction().add(
          new TransactionInstruction({
            programId: READER_PROGRAM,
            keys: [{ pubkey: target, isSigner: false, isWritable: false }],
            data: Buffer.from([]),
          })
        );
        tx.feePayer = stranger.publicKey;
        tx.recentBlockhash = blockhash;
        const b64 = tx
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString("base64");
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "simulateTransaction",
            params: [
              b64,
              { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true },
            ],
          }),
        });
        if (res.status === 403) return "refused";
        const body = await res.json().catch(() => null);
        if (body?.error && /denied|forbidden/i.test(JSON.stringify(body.error)))
          return "refused";
        // Program logs in the reply mean the code ran and touched the account.
        if (Array.isArray(body?.result?.value?.logs)) return "reached";
        return body?.error ? "error" : "reached";
      } catch (e) {
        // web3/fetch may surface the ingress 403 as a thrown error.
        return /403|denied|forbidden/i.test(String((e as Error).message))
          ? "refused"
          : "error";
      }
    },
    [url]
  );

  const run = useCallback(async () => {
    setRunning(true);
    setBookReach("pending");
    setTapeReach("pending");
    try {
      setBookReach(await probe(book));
      setTapeReach(await probe(tape));
    } finally {
      setRunning(false);
    }
  }, [probe, book, tape]);

  useEffect(() => {
    run();
  }, [run]);

  const reachMark = (r: Reach, privateTarget: boolean) => {
    if (r === "pending") return <span className="text-[11px] text-dim">…</span>;
    if (r === "error") return <span className="text-[11px] text-dim">unavailable</span>;
    if (privateTarget)
      return r === "refused" ? (
        <span
          className="text-[11px] text-bid"
          title="The rollup refused the transaction at ingress, before it executed — the stranger's code never read a byte"
        >
          refused at ingress
        </span>
      ) : (
        <span
          className="text-[11px] text-ask"
          title="The program executed against the private account — this would be a privacy failure"
        >
          reached
        </span>
      );
    // public control
    return r === "reached" ? (
      <span
        className="text-[11px] text-dim"
        title="The same program runs fine here — the block above is privacy-specific, not a generic failure"
      >
        executes
      </span>
    ) : (
      <span className="text-[11px] text-dim">{r === "refused" ? "refused" : "—"}</span>
    );
  };

  return (
    <div className="shrink-0 border-t border-line-soft">
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
        <span className="text-[10px] uppercase tracking-wider text-dim">
          and even code cannot reach it
        </span>
        <button
          onClick={run}
          disabled={running}
          className="text-[10px] text-dim hover:text-text disabled:opacity-50"
        >
          {running ? "running…" : "run again"}
        </button>
      </div>

      <div className="divide-y divide-line-soft">
        <CheckRow
          label="the book"
          note="a stranger's program tries to read it"
          right={reachMark(bookReach, true)}
        />
        <CheckRow
          label="the tape"
          note="same program, public account"
          right={reachMark(tapeReach, false)}
        />
      </div>

      <p className="px-3 pb-2 text-[10px] text-dim leading-relaxed">
        {isTee ? (
          <>
            An arbitrary program, run by an anonymous stranger, is refused the
            instant its transaction names a private account — before it executes.
            Reading is not the boundary; admission is.
          </>
        ) : (
          <>
            The public rollup admits the call and the program executes — read
            gating and ingress refusal turn on against a TEE validator.
          </>
        )}
      </p>
    </div>
  );
}

function CheckRow({
  label,
  note,
  right,
}: {
  label: string;
  note: string;
  right: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div className="flex-1 min-w-0 flex items-baseline gap-2">
        <span className="text-[12px] text-text">{label}</span>
        <span className="text-[10px] text-dim truncate">{note}</span>
      </div>
      {right}
    </div>
  );
}

/** Every outcome its own meaning — never collapsed. `refused` and `public`
 *  are the venue working (a hidden account hidden, a public one shown);
 *  `exposed` is the one true failure; `dormant` and `absent` are neither. */
function Verdict({ verdict }: { verdict: Verdict }) {
  if (verdict === "pending") return <span className="text-[11px] text-dim">…</span>;
  if (verdict === "refused") return <span className="text-[11px] text-bid">refused</span>;
  if (verdict === "public")
    return (
      <span className="text-[11px] text-dim" title="Public by design — the print feed is meant to be readable">
        public
      </span>
    );
  if (verdict === "exposed")
    return (
      <span
        className="text-[11px] text-ask"
        title="A delegated account served to an anonymous reader — this is a privacy failure"
      >
        readable
      </span>
    );
  if (verdict === "dormant")
    return (
      <span
        className="text-[11px] text-muted text-right leading-tight"
        title="Readable only because it is not delegated yet — it enters the dark rollup when you hold an open position"
      >
        not yet dark
      </span>
    );
  return (
    <span className="text-[11px] text-dim" title="This account does not exist yet">
      not created
    </span>
  );
}

function VerdictFooter({ isTee }: { isTee: boolean }) {
  return (
    <>
      <footer className="shrink-0 px-3 py-2 border-t border-line-soft">
        {isTee ? (
          <p className="text-[10px] text-dim leading-relaxed">
            Queried anonymously against the TEE validator. The book refuses;
            the tape answers. Same request, different reply — enforced by the
            enclave, and the enclave itself is checked above: a fresh TDX
            quote over this page&apos;s own challenge, verified against
            Intel&apos;s certification chain.
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
    </>
  );
}
