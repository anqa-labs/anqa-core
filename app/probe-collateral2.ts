/**
 * Read-only margin diagnostic + targeted removal tests:
 *  1. print every asset's collateral / position / margin-vs-IM arithmetic,
 *  2. drain $1 from a FLAT slot with stranded collateral (the residue the
 *     2026-08-05 notes said had "no release instruction yet"),
 *  3. remove a computed-safe amount from an open position if headroom exists.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import fs from "fs";
import { teeAuthToken } from "./tee-auth";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const GROUP = 930;
const IM = 0.05, POS_SCALE = 1_000_000n;
const S = (x: string) => Buffer.from(x);
const le8 = (n: any) => new BN(n).toArrayLike(Buffer, "le", 8);
const PF_HEADER = 8 + 32 + 8 + 1 + 16 + 8;
const PF_COLLATERAL = PF_HEADER;
const PF_INNER = PF_COLLATERAL + 12 * 16 + 12 * 16;
const LEGS = 340, LEG_STRIDE = 144;

const u128 = (d: Buffer, at: number) => d.readBigUInt64LE(at); // low half suffices
const collatOf = (d: Buffer, a: number) => u128(d, PF_COLLATERAL + a * 16);
const entryOf = (d: Buffer, a: number) => u128(d, PF_COLLATERAL + 12 * 16 + a * 16);

function legs(d: Buffer) {
  const out: { asset: number; isLong: boolean; lots: bigint }[] = [];
  for (let i = 0; i < 4; i++) {
    const at = PF_INNER + LEGS + i * LEG_STRIDE;
    if (d[at] !== 1) continue;
    const basis = d.readBigInt64LE(at + 14);
    if (basis === 0n) continue;
    out.push({
      asset: d.readUInt32LE(at + 1),
      isLong: d[at + 13] === 0,
      lots: (basis < 0n ? -basis : basis) / POS_SCALE,
    });
  }
  return out;
}

(async () => {
  const maker = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(`app/.mm-maker-${GROUP}.json`, "utf-8")))
  );
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const er = new Connection(
    `https://devnet-tee.magicblock.app?token=${await teeAuthToken(maker, "https://devnet-tee.magicblock.app")}`,
    "confirmed"
  );
  const p = new Program(
    idl,
    new anchor.AnchorProvider(er, new anchor.Wallet(maker), { commitment: "processed" })
  ) as any;
  const g = (t: string, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(GROUP), ...e], PROGRAM_ID)[0];
  const m = (t: string, id: number) =>
    PublicKey.findProgramAddressSync([S(t), le8(id)], PROGRAM_ID)[0];
  const portfolio = g("anqa_portfolio", [maker.publicKey.toBuffer()]);
  const d = (await er.getAccountInfo(portfolio))!.data as Buffer;

  const open = new Map(legs(d).map((l) => [l.asset, l]));
  const marks = new Map<number, bigint>();
  for (const a of open.keys()) {
    const osx: any = await p.account.oracleState.fetch(m("anqa_oracle", GROUP + a));
    marks.set(a, BigInt(String(osx.lastPrice ?? osx.last_price ?? 0)));
  }

  let flatWithResidue = -1;
  let safeRemove: { asset: number; usd: number } | null = null;
  for (let a = 0; a < 9; a++) {
    const c = collatOf(d, a);
    if (c === 0n) continue;
    const leg = open.get(a);
    if (!leg) {
      console.log(`asset ${a}: FLAT, stranded collateral $${(Number(c) / 1e6).toFixed(2)}`);
      if (flatWithResidue < 0) flatWithResidue = a;
      continue;
    }
    const mark = marks.get(a)!, entry = entryOf(d, a);
    const pnl = (leg.isLong ? mark - entry : entry - mark) * leg.lots;
    const im = (mark * leg.lots * 500n) / 10_000n;
    const headroom = c + pnl - im;
    console.log(
      `asset ${a}: ${leg.isLong ? "long" : "short"} ${leg.lots} lots — collat $${(Number(c) / 1e6).toFixed(2)}, pnl $${(Number(pnl) / 1e6).toFixed(2)}, IM $${(Number(im) / 1e6).toFixed(2)} → removable $${(Number(headroom) / 1e6).toFixed(2)}`
    );
    if (!safeRemove && headroom > 2_000_000n)
      safeRemove = { asset: a, usd: Number(headroom - 1_000_000n) / 1e6 };
  }

  const send = async (method: string, marketId: number, atoms: bigint) => {
    const ix = await p.methods[method](new BN(atoms.toString()))
      .accounts({
        trader: maker.publicKey, session: null,
        market: m("anqa_market", marketId),
        riskGroup: g("anqa_risk"), assetSlots: g("anqa_assets"),
        oracleState: m("anqa_oracle", marketId), portfolio,
      })
      .instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = maker.publicKey;
    tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
    tx.sign(maker);
    const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    for (let i = 0; i < 20; i++) {
      const st = (await er.getSignatureStatus(sig)).value;
      if (st?.err) throw new Error(`${method} failed: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`${method}: no status`);
  };

  if (flatWithResidue >= 0) {
    const a = flatWithResidue;
    await send("removeCollateral", GROUP + a, 1_000_000n);
    const d2 = (await er.getAccountInfo(portfolio))!.data as Buffer;
    console.log(`FLAT DRAIN PASS — asset ${a} residue now $${(Number(collatOf(d2, a)) / 1e6).toFixed(2)}`);
  }
  if (safeRemove) {
    const atoms = BigInt(Math.floor(safeRemove.usd * 1e6));
    await send("removeCollateral", GROUP + safeRemove.asset, atoms);
    const d2 = (await er.getAccountInfo(portfolio))!.data as Buffer;
    console.log(`OPEN-POSITION REMOVE PASS — asset ${safeRemove.asset} took out $${safeRemove.usd.toFixed(2)}, now $${(Number(collatOf(d2, safeRemove.asset)) / 1e6).toFixed(2)}`);
  } else if (process.env.MAKE_HEADROOM === "1") {
    // Manufacture headroom on asset 0: add enough to clear IM plus $500,
    // then remove $400 of it — proves the success path of both directions
    // with real margin math standing in between.
    const a = 0, leg = open.get(a)!;
    const mark = marks.get(a)!, entry = entryOf(d, a);
    const pnl = (leg.isLong ? mark - entry : entry - mark) * leg.lots;
    const im = (mark * leg.lots * 500n) / 10_000n;
    const need = im - pnl - collatOf(d, a) + 500_000_000n;
    console.log(`adding $${(Number(need) / 1e6).toFixed(2)} to clear IM with $500 headroom…`);
    await send("addCollateral", GROUP + a, need);
    await send("removeCollateral", GROUP + a, 400_000_000n);
    const d2 = (await er.getAccountInfo(portfolio))!.data as Buffer;
    console.log(`OPEN-POSITION REMOVE PASS — collat now $${(Number(collatOf(d2, a)) / 1e6).toFixed(2)}`);
  } else {
    console.log("no open position has IM headroom — 6048 was the guard being right");
  }
})();
