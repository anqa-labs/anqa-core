/**
 * Bring the risk engine home from the rollup.
 *
 * `undelegate_risk` commits the risk group and the slabs back to base in one
 * bundle and hands ownership back to the program. Needed for base-layer
 * kernel maintenance — funding insurance, above all — after which
 * `provision-hub.ts` re-delegates them (it is idempotent; run it next).
 *
 * Stop the keepers first: pkill -f app/keeper.ts
 *
 * Run: npx ts-node --transpile-only app/undelegate-risk.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4uLF3kQu9Hz93xKNThVdqV2H1EAdF1xy1xRKYzmi8T4j");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet.magicblock.app";
const GROUP = Number(process.env.ANQA_GROUP ?? 820);

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const er = new Connection(ER_RPC, "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8")))
  );
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  // skipPreflight: the ER's simulation lane can present delegated accounts
  // with their base-layer owner and refuse a tx the validator executes fine.
  const pEr = new Program(
    idl,
    new anchor.AnchorProvider(er, new anchor.Wallet(payer), {
      commitment: "confirmed",
      skipPreflight: true,
    })
  ) as any;

  const le8 = (n: number) => new BN(n).toArrayLike(Buffer, "le", 8);
  const pda = (tag: string) =>
    PublicKey.findProgramAddressSync([Buffer.from(tag), le8(GROUP)], PROGRAM_ID)[0];
  const gRisk = pda("anqa_risk");
  const gAssets = pda("anqa_assets");

  const owner = async (k: PublicKey) => (await conn.getAccountInfo(k))?.owner;
  if (!(await owner(gRisk))?.equals(DLP)) {
    console.log("risk engine is already on base — nothing to do");
    return;
  }

  const MAGIC = {
    magicProgram: new PublicKey("Magic11111111111111111111111111111111111111"),
    magicContext: new PublicKey("MagicContext1111111111111111111111111111111"),
  };
  // Group first, then slabs — separate bundles (the validator rejects a
  // two-account bundle), safe because no kernel write touches slabs alone.
  const s1 = await pEr.methods
    .undelegateRiskGroup()
    .accounts({ payer: payer.publicKey, riskGroup: gRisk, ...MAGIC })
    .rpc({ skipPreflight: true });
  console.log("risk group undelegate sent:", s1);
  const s2 = await pEr.methods
    .undelegateAssetSlots()
    .accounts({ payer: payer.publicKey, assetSlots: gAssets, ...MAGIC })
    .rpc({ skipPreflight: true });
  console.log("slabs undelegate sent:", s2);

  // The commit lands on base asynchronously; wait for ownership to flip.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const [ro, ao] = await Promise.all([owner(gRisk), owner(gAssets)]);
    if (ro?.equals(PROGRAM_ID) && ao?.equals(PROGRAM_ID)) {
      console.log("risk engine is home — run provision-hub.ts to fund + re-delegate");
      return;
    }
  }
  throw new Error("commit did not land within 2 minutes — check the rollup");
}

main().catch((e) => {
  console.error(e.logs ?? e);
  process.exit(1);
});
