/** Flatten the resident maker's inventory across the hub.
 *
 *  The daemon caps its position and stops quoting a side once it is full, so a
 *  demo run that filled it up leaves a one-sided (or empty) book. Closing its
 *  positions puts a full ladder back on every market. */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import { teeAuthToken } from "./tee-auth";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const ER_RPC = (process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app").split("?")[0];
const GROUP_ID = new BN("930");
const MARKETS = [930, 931, 932, 933, 934, 935, 936, 937, 938];

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const maker = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync("app/.mm-maker-930.json", "utf-8")))
  );
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          process.env.ANQA_KEEPER_KEY ?? path.join(os.homedir(), ".config/solana/id.json"),
          "utf-8"
        )
      )
    )
  );
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const er = new Connection(`${ER_RPC}?token=${await teeAuthToken(maker, ER_RPC)}`, "confirmed");
  const erK = new Connection(`${ER_RPC}?token=${await teeAuthToken(admin, ER_RPC)}`, "confirmed");
  const mk = (c: Connection, kp: Keypair) =>
    new Program(
      idl,
      new anchor.AnchorProvider(c, new anchor.Wallet(kp), { commitment: "processed", skipPreflight: true })
    ) as any;
  const p = mk(er, maker);
  const pk = mk(erK, admin);

  const g = (t: string, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(GROUP_ID), ...e], PROGRAM_ID)[0];
  const m = (t: string, id: number) =>
    PublicKey.findProgramAddressSync([S(t), le8(id)], PROGRAM_ID)[0];
  const riskGroup = g("anqa_risk");
  const assetSlots = g("anqa_assets");
  const portfolio = g("anqa_portfolio", [maker.publicKey.toBuffer()]);

  const send = async (ix: any, label: string) => {
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ix
    );
    tx.feePayer = maker.publicKey;
    tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
    tx.sign(maker);
    const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    for (let i = 0; i < 24; i++) {
      await sleep(250);
      const st = await er.getSignatureStatus(sig).catch(() => null);
      if (st?.value?.err) throw new Error(`${label}: ${JSON.stringify(st.value.err)}`);
      if (st?.value?.confirmationStatus) return sig;
    }
    throw new Error(`${label}: not confirmed`);
  };

  for (const id of MARKETS) {
    const market = m("anqa_market", id);
    const book = m("anqa_book", id);
    const oracleState = m("anqa_oracle", id);
    // Cancel both sides first: resting orders hold margin, and the close walks
    // the same book it is quoting into.
    for (const side of ["bid", "ask"] as const) {
      try {
        await send(
          await p.methods
            .cancelAll(side === "bid" ? { bid: {} } : { ask: {} })
            .accounts({ trader: maker.publicKey, session: null, market, book, portfolio })
            .instruction(),
          `${id} cancelAll ${side}`
        );
      } catch {
        // No cancel_all on this build, or nothing resting — the close below is
        // what actually matters.
      }
    }
    // The worst price must sit inside the oracle band (6033), so derive it
    // from the book's own mid rather than guessing a wide number. The close
    // direction depends on the position's sign, which is private — so try a
    // tolerance either side and let the one matching the position win.
    const bk: any = await pk.account.book.fetch(book).catch(() => null);
    const top = (side: any) => {
      const orders = side?.orders ?? [];
      const head = Number(side?.head ?? 0xffff);
      const o = head !== 0xffff ? orders[head] : null;
      return o ? Number(o.priceInTicks ?? o.price_in_ticks) : 0;
    };
    const bid = bk ? top(bk.bids) : 0;
    const ask = bk ? top(bk.asks) : 0;
    const mid = bid && ask ? (bid + ask) / 2 : bid || ask;
    if (!mid) {
      console.log(id, "no book prices — skipping");
      continue;
    }
    let done = false;
    for (const factor of [1.01, 0.99]) {
      try {
        await send(
          await p.methods
            .closePosition(new BN(Math.max(1, Math.round(mid * factor))), new BN(0))
            .accounts({
              trader: maker.publicKey, session: null, market, book,
              riskGroup, assetSlots, oracleState, portfolio,
            })
            .instruction(),
          `${id} close`
        );
        console.log(id, "flattened");
        done = true;
        break;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        // 6038 = no open position: already flat, nothing to do here.
        if (msg.includes("6038")) {
          console.log(id, "already flat");
          done = true;
          break;
        }
      }
    }
    if (!done) console.log(id, "could not flatten — check manually");
  }
  console.log("done — restart the maker daemon to re-lay full ladders");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("FAILED:", e?.msg ?? e?.message ?? e);
    process.exit(1);
  }
);
