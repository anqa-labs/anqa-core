import { Connection, PublicKey } from "@solana/web3.js";
import { baseConnection } from "./rpc";
const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const PREFIX = process.env.ANQA_PREFIX ?? "5NTx";
(async () => {
  const conn = baseConnection("https://api.devnet.solana.com");
  const all = await conn.getProgramAccounts(PROGRAM_ID, { dataSlice: { offset: 8, length: 32 } });
  const seen = new Set<string>();
  for (const a of all) {
    const owner = new PublicKey(a.account.data).toBase58();
    if (owner.startsWith(PREFIX) && !seen.has(owner)) { seen.add(owner); console.log(owner); }
  }
})();
