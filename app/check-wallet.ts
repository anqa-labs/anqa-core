import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import fs from "fs";
import { baseConnection } from "./rpc";
(async () => {
  const conn = baseConnection("https://api.devnet.solana.com");
  const owner = new PublicKey("3WxbvGCDazYLFnXXkgjtvnM3CR7uPr14VSHCdyzmTQ3d");
  const mint = new PublicKey(JSON.parse(fs.readFileSync("app/.demo-mint-930.json", "utf-8")).mint);
  const ata = getAssociatedTokenAddressSync(mint, owner);
  console.log("wallet ", owner.toBase58());
  console.log("USDC ata", ata.toBase58());
  const bal = await conn.getTokenAccountBalance(ata).catch((e: any) => ({ value: { uiAmount: "ERR " + String(e).slice(0, 60) } }));
  console.log("USDC balance:", (bal as any).value.uiAmount);
  console.log("SOL balance :", (await conn.getBalance(owner)) / 1e9);
})();
