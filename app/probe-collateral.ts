/**
 * Live proof of the collateral lever: add $1 behind an open maker position,
 * read it back, take the $1 out again, read it back. Net zero, both paths
 * exercised against the real ER.
 *
 *   npx ts-node --transpile-only app/probe-collateral.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import fs from "fs";
import { teeAuthToken } from "./tee-auth";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const GROUP = 930;
const S = (x: string) => Buffer.from(x);
const le8 = (n: any) => new BN(n).toArrayLike(Buffer, "le", 8);

// Wrapper layout (mirror of web/lib/portfolio.ts).
const PF_HEADER = 8 + 32 + 8 + 1 + 16 + 8;
const PF_COLLATERAL = PF_HEADER;
const PF_INNER = PF_COLLATERAL + 12 * 16 + 12 * 16;
const LEGS = 340, LEG_STRIDE = 144;

const collatOf = (d: Buffer, asset: number) =>
  Number(d.readBigUInt64LE(PF_COLLATERAL + asset * 16)) / 1e6;

function openAssets(d: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const at = PF_INNER + LEGS + i * LEG_STRIDE;
    const active = d[at] === 1;
    const asset = d.readUInt32LE(at + 1);
    const basis = d.readBigInt64LE(at + 14); // low half is plenty for != 0
    if (active && basis !== 0n) out.push(asset);
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

  const read = async () => (await er.getAccountInfo(portfolio))!.data as Buffer;

  let d = await read();
  const open = openAssets(d);
  if (open.length === 0) throw new Error("maker holds no open position to test against");
  const asset = open[0];
  const marketId = GROUP + asset;
  console.log(`asset ${asset} (market ${marketId}) — collateral before: $${collatOf(d, asset).toFixed(2)}`);

  const send = async (method: "addCollateral" | "removeCollateral") => {
    const ix = await p.methods[method](new BN(200_000_000))
      .accounts({
        trader: maker.publicKey,
        session: null,
        market: m("anqa_market", marketId),
        riskGroup: g("anqa_risk"),
        assetSlots: g("anqa_assets"),
        oracleState: m("anqa_oracle", marketId),
        portfolio,
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
      if (st?.confirmationStatus) return sig;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`${method}: no status after 10s (sig ${sig})`);
  };

  await send("addCollateral");
  d = await read();
  console.log(`after add $200:    $${collatOf(d, asset).toFixed(2)}`);

  await send("removeCollateral");
  d = await read();
  console.log(`after remove $200: $${collatOf(d, asset).toFixed(2)}`);
  console.log("PASS — both directions live on the ER");
})();
