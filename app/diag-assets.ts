/**
 * Dump every asset slot in the risk engine, side by side.
 *
 * One asset (BTC, index 0) refuses every fill with `LockActive` while the
 * others trade normally, so the answer is a field that differs between them.
 *
 * Layout: the slabs are `[8-byte anchor disc][ PercMarket<AssetTag> × 12 ]`,
 * each `PercMarket` being an 8-byte tag followed by the kernel's
 * `EngineAssetSlotV16Account`, whose first member is `AssetStateV16Account`.
 * Every field is a byte array (align 1), so offsets are just cumulative.
 *
 * Run: npx ts-node --transpile-only app/diag-assets.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { baseConnection } from "./rpc";
import { teeRpcFor } from "./tee-auth";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const ER_RPC = process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app";
const GROUP_ID = new BN(process.env.ANQA_GROUP ?? 920);

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const NAMES = ["BTC", "SOL", "ETH", "XRP", "DOGE", "LINK", "AVAX", "SUI", "BNB"];

const DISC = 8;
const TAG = 8;
const STRIDE = 1293; // sizeof(PercMarket<AssetTag>) — 8 + 1285 (15524 = 8 + 1293*12)

// AssetStateV16Account field offsets (align 1, cumulative)
const O_MARKET_ID = 0;
const O_RETIRED_SLOT = 8;
const O_LIFECYCLE = 16;
const O_RAW_TARGET = 17;
const O_EFFECTIVE = 25;
const O_FUND_PX = 33;
const O_SLOT_LAST = 41;
const O_OI_LONG = 273;
const O_OI_SHORT = 289;
const O_POS_CNT_LONG = 305;
const O_POS_CNT_SHORT = 313;
const O_STALE_LONG = 321;
const O_STALE_SHORT = 329;
const O_PENDING_LONG = 337;
const O_PENDING_SHORT = 345;
const O_LOSS_W_LONG = 353;
const O_LOSS_W_SHORT = 369;

const LIFECYCLE = [
  "Disabled",
  "PendingActivation",
  "Active",
  "DrainOnly",
  "Retired",
  "Recovery",
];

const u = (b: Buffer, off: number, len: number) => {
  let v = 0n;
  for (let i = len - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i] ?? 0);
  return v;
};

async function main() {
  const conn = baseConnection(RPC);
  const keeper = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(
      process.env.ANQA_KEEPER_KEY ?? path.join(os.homedir(), ".config/solana/id.json"), "utf-8"
    )))
  );
  const er = new Connection(await teeRpcFor(keeper, ER_RPC), "confirmed");
  const gpda = (t: string) => PublicKey.findProgramAddressSync([S(t), le8(GROUP_ID)], PROGRAM_ID)[0];

  const info = await er.getAccountInfo(gpda("anqa_assets"));
  if (!info) return console.log("asset slots unreadable");
  const b = Buffer.from(info.data);
  console.log(`asset slots: ${b.length} bytes → stride ${STRIDE}, ${(b.length - DISC) / STRIDE} slots\n`);

  // The kernel's own notion of "now" lives on the risk group header.
  const rg = await er.getAccountInfo(gpda("anqa_risk"));
  console.log(`risk group account: ${rg?.data.length} bytes`);

  for (let i = 0; i < 9; i++) {
    const a = DISC + i * STRIDE + TAG;
    const life = b[a + O_LIFECYCLE];
    console.log(
      `asset ${i} ${(NAMES[i] ?? "?").padEnd(5)} lifecycle=${(LIFECYCLE[life] ?? life).toString().padEnd(9)}` +
      ` marketId=${u(b, a + O_MARKET_ID, 8)}`
    );
    console.log(
      `          target=${u(b, a + O_RAW_TARGET, 8)} effective=${u(b, a + O_EFFECTIVE, 8)}` +
      ` fundPx=${u(b, a + O_FUND_PX, 8)} slotLast=${u(b, a + O_SLOT_LAST, 8)}`
    );
    const oiL = u(b, a + O_OI_LONG, 16), oiS = u(b, a + O_OI_SHORT, 16);
    console.log(
      `          OI long=${oiL} short=${oiS}${oiL !== oiS ? "   <-- IMBALANCED (invalid in Live mode)" : ""}` +
      ` posCnt=${u(b, a + O_POS_CNT_LONG, 8)}/${u(b, a + O_POS_CNT_SHORT, 8)}`
    );
    console.log(
      `          stale=${u(b, a + O_STALE_LONG, 8)}/${u(b, a + O_STALE_SHORT, 8)}` +
      ` pendingObl=${u(b, a + O_PENDING_LONG, 8)}/${u(b, a + O_PENDING_SHORT, 8)}` +
      ` lossW=${u(b, a + O_LOSS_W_LONG, 16)}/${u(b, a + O_LOSS_W_SHORT, 16)}`
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
