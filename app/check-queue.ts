import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs"; import os from "os"; import path from "path";
import { teeAuthToken } from "./tee-auth";
const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const NIL = 0xffff;
function walk(side: any): any[] {
  const r: any[] = []; const o = side?.orders ?? []; let c = Number(side?.head ?? NIL); const v = new Set<number>();
  while (c !== NIL && c >= 0 && c < o.length && !v.has(c)) { v.add(c); const x = o[c]; if (!x) break; if (x.active === 1) r.push(x); c = Number(x.next ?? NIL); }
  return r;
}
(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const er = new Connection(`https://devnet-tee.magicblock.app?token=${await teeAuthToken(admin, "https://devnet-tee.magicblock.app")}`, "confirmed");
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const p = new Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(admin), { commitment: "confirmed" })) as any;
  const mm = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("app/.mm-maker-930.json", "utf-8")))).publicKey.toBase58();
  const demo = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("app/.demo-maker-930.json", "utf-8")))).publicKey.toBase58();
  const book = PublicKey.findProgramAddressSync([Buffer.from("anqa_book"), new BN(931).toArrayLike(Buffer, "le", 8)], PROGRAM_ID)[0];
  const bk: any = await p.account.book.fetch(book);
  console.log("pending:", Number(bk.pendingCount ?? bk.pending_count));
  console.log("mm-maker:", mm.slice(0,8), " demo-maker:", demo.slice(0,8));
  walk(bk.bids).slice(0, 12).forEach((o: any, i: number) => {
    const t = new PublicKey(o.trader).toBase58();
    const who = t === mm ? "MM" : t === demo ? "DEMO" : "user:" + t.slice(0, 8);
    console.log(` bid[${i}] ${who} ${o.baseLots ?? o.base_lots}@${o.priceInTicks ?? o.price_in_ticks} id=${o.clientOrderId ?? o.client_order_id}${(o.hidden ?? 0) === 1 ? " hidden" : ""}`);
  });
})();
