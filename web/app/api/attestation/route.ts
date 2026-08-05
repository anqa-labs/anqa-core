import { NextResponse } from "next/server";
import { getCollateral, verify, Quote } from "@phala/dcap-qvl";

/**
 * TDX attestation for the rollup endpoint, verified server-side.
 *
 * The ProofPanel shows that a stranger's read of the book returns nothing.
 * A fair skeptic answers: "because the operator's server chooses to return
 * nothing — you are trusting them." This route closes that gap. The TEE
 * validator will sign a fresh quote over any 64-byte challenge; Intel's DCAP
 * chain then proves the quote came from a genuine TDX enclave with current
 * firmware, and the challenge echo proves it was minted seconds ago rather
 * than replayed.
 *
 * The trust split is deliberate: DCAP verification (certificate chains, CRLs,
 * TCB info from Intel's certification service) runs here on the server, but
 * the **challenge is generated in the browser** and the report data is
 * returned raw — so the one check that binds the result to *this page load*
 * is the client's own comparison, not our word.
 *
 * The quote endpoint itself is public and unauthenticated; anyone can rerun
 * this against `${TEE}/quote` with their own challenge and the same open
 * library (@phala/dcap-qvl) and get the same answer.
 */

const TEE_BASE = (process.env.NEXT_PUBLIC_ER_RPC ?? "https://devnet-tee.magicblock.app").split(
  "?"
)[0];
const PCCS = "https://pccs.phala.network/tdx/certification/v4";

const hex = (u8: Uint8Array) => Buffer.from(u8).toString("hex");

export async function GET(req: Request) {
  const url = new URL(req.url);

  // The browser's challenge: exactly 64 bytes, base64. Refusing anything else
  // keeps the freshness check meaningful — a short or reused challenge would
  // verify fine and prove nothing.
  const challengeB64 = url.searchParams.get("challenge") ?? "";
  let challenge: Buffer;
  try {
    challenge = Buffer.from(challengeB64, "base64");
  } catch {
    challenge = Buffer.alloc(0);
  }
  if (challenge.length !== 64) {
    return NextResponse.json(
      { stage: "challenge", error: "challenge must be 64 bytes, base64-encoded" },
      { status: 400 }
    );
  }

  // 1. Ask the enclave to sign our challenge into a fresh quote.
  let raw: Buffer;
  try {
    const r = await fetch(
      `${TEE_BASE}/quote?challenge=${encodeURIComponent(challenge.toString("base64"))}`,
      { cache: "no-store" }
    );
    const body = await r.json();
    if (!r.ok || typeof body.quote !== "string") {
      throw new Error(body.error ?? `upstream ${r.status}`);
    }
    raw = Buffer.from(body.quote, "base64");
  } catch (e) {
    // A non-TEE endpoint has no /quote — that is a finding, not a bug, and
    // the panel reports it as "this endpoint offers no attestation".
    return NextResponse.json({ stage: "quote", error: String((e as Error).message) });
  }

  // 2. Fetch collateral (PCK CRLs, TCB info, QE identity) and run the DCAP
  //    verification: signature chain to Intel's root CA, revocation, TCB.
  try {
    const collateral = await getCollateral(PCCS, raw);
    const report = verify(raw, collateral, Math.floor(Date.now() / 1000));

    // 3. Parse the verified quote and hand the raw pieces back. The client
    //    compares reportData against the challenge it generated itself.
    const quote = Quote.parse(raw);
    const td = quote.report.asTd10() ?? quote.report.asTd15()?.base;
    if (!td) {
      return NextResponse.json({ stage: "parse", error: "quote is not a TDX report" });
    }

    return NextResponse.json({
      stage: "done",
      endpoint: TEE_BASE,
      tcbStatus: report.status,
      advisories: report.advisory_ids,
      reportData: hex(td.reportData),
      mrTd: hex(td.mrTd),
      rtMr0: hex(td.rtMr0),
      rtMr1: hex(td.rtMr1),
      rtMr2: hex(td.rtMr2),
      rtMr3: hex(td.rtMr3),
      verifiedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ stage: "verify", error: String((e as Error).message) });
  }
}
