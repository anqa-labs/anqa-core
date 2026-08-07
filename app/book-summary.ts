import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs"; import os from "os"; import path from "path";
import { teeAuthToken } from "./tee-auth";
const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const NIL = 0xffff;
const SYM: any = { 930: "BTC", 931: "SOL", 932: "ETH", 933: "XRP", 934: "DOGE", 935: "LINK", 936: "AVAX", 937: "SUI", 938: "BNB" };
function walk(s: any): any[] {
  const r: any[] = []; const o = s?.orders ?? []; let c = Number(s?.head ?? NIL); const v = new Set<number>();
  while (c !== NIL && c >= 0 && c < o.length && !v.has(c)) { v.add(c); const x = o[c]; if (!x) break; if (x.active === 1) r.push(x); c = Number(x.next ?? NIL); }
  return r;
}
(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const er = new Connection(`https://devnet-tee.magicblock.app?token=${await teeAuthToken(admin, "https://devnet-tee.magicblock.app")}`, "confirmed");
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const p = new Program(idl, new anchor.AnchorProvider(er, new anchor.Wallet(admin), { commitment: "confirmed" })) as any;
  console.log("mkt  sym   bids asks  top bid / top ask");
  for (const id of [930,931,932,933,934,935,936,937,938]) {
    const book = PublicKey.findProgramAddressSync([Buffer.from("anqa_book"), new BN(id).toArrayLike(Buffer, "le", 8)], PROGRAM_ID)[0];
    const bk: any = await p.account.book.fetch(book).catch(() => null);
    if (!bk) { console.log(id, SYM[id], "unreadable"); continue; }
    const b = walk(bk.bids), a = walk(bk.asks);
    const px = (o: any) => (o ? String(o.priceInTicks ?? o.price_in_ticks) : "—");
    const flag = b.length && a.length ? "" : "   <-- ONE-SIDED";
    console.log(`${id}  ${SYM[id].padEnd(5)} ${String(b.length).padStart(4)} ${String(a.length).padStart(4)}  ${px(b[0])} / ${px(a[0])}${flag}`);
  }
})();
