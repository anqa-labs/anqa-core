/**
 * Create the venue's own clock for a hub, and send it into the rollup.
 *
 * Run once per group, after deploying a build that carries `VenueClock`. It is
 * idempotent: an existing clock is left alone, and an already-delegated one is
 * left where it is.
 *
 * This is what unfreezes a venue whose kernel clock was stamped on base layer
 * and then delegated to a rollup running behind it — see
 * `state/venue_clock.rs`. No re-provisioning, no new mint.
 *
 *   npx ts-node --transpile-only app/rescue-clock.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import { baseConnection } from "./rpc";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const GROUP = Number(process.env.ANQA_GROUP ?? 900);

async function main() {
  const conn = baseConnection(RPC);
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))
    )
  );
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const p = new Program(
    idl,
    new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" })
  ) as any;

  const le8 = (n: number) => new BN(n).toArrayLike(Buffer, "le", 8);
  const clock = PublicKey.findProgramAddressSync(
    [Buffer.from("anqa_clock"), le8(GROUP)],
    PROGRAM_ID
  )[0];
  const market = PublicKey.findProgramAddressSync(
    [Buffer.from("anqa_market"), le8(GROUP)],
    PROGRAM_ID
  )[0];

  const info = await conn.getAccountInfo(clock);
  if (!info) {
    await p.methods
      .initializeVenueClock(new BN(GROUP))
      .accounts({
        payer: payer.publicKey,
        market,
        authority: payer.publicKey,
        venueClock: clock,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const c: any = await p.account.venueClock.fetch(clock);
    console.log(`clock created for group ${GROUP} — starts at ${c.venueSlot}`);
  } else if (info.owner.equals(DLP)) {
    console.log("clock already delegated — nothing to do");
    return;
  } else {
    const c: any = await p.account.venueClock.fetch(clock);
    console.log(`clock exists at ${c.venueSlot} (raw ${c.lastRaw})`);
  }

  // Ordering matters on a fresh hub: `activate_asset` runs on base during
  // provisioning and needs the clock to exist, but it must still be
  // program-owned at that point. So creation and delegation are separable —
  // create it first, provision, then send it into the rollup with the risk
  // group it belongs to.
  if (process.env.ANQA_CLOCK_INIT_ONLY === "1") {
    console.log("clock created on base — provision now, then delegate");
    return;
  }

  await p.methods
    .delegateVenueClock(new BN(GROUP))
    .accounts({ payer: payer.publicKey, venueClock: clock })
    .rpc();
  console.log("clock delegated — the venue now keeps its own time");
}

main().catch((e) => {
  console.error(e.logs ?? e);
  process.exit(1);
});
