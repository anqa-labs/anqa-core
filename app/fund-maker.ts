/** Top the resident maker's collateral up.
 *
 *  Resting orders hold margin, so a nine-market ladder plus any inventory can
 *  exhaust the maker's capital — the symptom is `6010` (risk engine refused)
 *  on the markets it happens to quote last, which then show an empty book
 *  while the earlier markets look fine. */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import { baseConnection } from "./rpc";
import { teeAuthToken } from "./tee-auth";

const PROGRAM_ID = new PublicKey("4F7QYiHQn51zCdE2XMVqiezamf4pGpLZzYVykqteBBNW");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const GROUP_ID = new BN("930");
const ER_RPC = (process.env.ANQA_ER_RPC ?? "https://devnet-tee.magicblock.app").split("?")[0];
const AMOUNT = Number(process.env.ANQA_MM_TOPUP ?? 20_000_000) * 1e6;
const CAPITAL_OFF = 73 + 12 * 16 + 12 * 16 + 132;

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
  const conn = baseConnection(process.env.ANQA_RPC ?? "https://api.devnet.solana.com");
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const p = new Program(
    idl,
    new anchor.AnchorProvider(conn, new anchor.Wallet(maker), { commitment: "confirmed", skipPreflight: true })
  ) as any;
  const er = new Connection(`${ER_RPC}?token=${await teeAuthToken(maker, ER_RPC)}`, "confirmed");

  const g = (t: string, e: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(t), le8(GROUP_ID), ...e], PROGRAM_ID)[0];
  const portfolio = g("anqa_portfolio", [maker.publicKey.toBuffer()]);
  const ledger = g("anqa_ledger", [maker.publicKey.toBuffer()]);
  const receipt = g("anqa_dreceipt", [maker.publicKey.toBuffer()]);
  const groupMarket = g("anqa_market");
  const vault = g("anqa_vault");
  const d = {
    buffer: PublicKey.findProgramAddressSync([S("buffer"), receipt.toBuffer()], PROGRAM_ID)[0],
    delegationRecord: PublicKey.findProgramAddressSync([S("delegation"), receipt.toBuffer()], DLP)[0],
    delegationMetadata: PublicKey.findProgramAddressSync([S("delegation-metadata"), receipt.toBuffer()], DLP)[0],
  };

  const capital = async () => {
    const info = await er.getAccountInfo(portfolio).catch(() => null);
    return info ? Number(info.data.readBigUInt64LE(CAPITAL_OFF)) / 1e6 : 0;
  };
  console.log("capital before:", (await capital()).toLocaleString(), "USDC");

  const mint = new PublicKey(JSON.parse(fs.readFileSync("app/.demo-mint-930.json", "utf-8")).mint);
  const ata = await getOrCreateAssociatedTokenAccount(conn, admin, mint, maker.publicKey);
  await mintTo(conn, admin, mint, ata.address, admin, AMOUNT);
  await p.methods
    .deposit(new BN(AMOUNT), false)
    .accounts({
      trader: maker.publicKey, market: groupMarket, ledger,
      traderTokenAccount: ata.address, vault,
      receipt, buffer: d.buffer, delegationRecord: d.delegationRecord, delegationMetadata: d.delegationMetadata,
      ownerProgram: PROGRAM_ID, delegationProgram: DLP, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`deposited ${(AMOUNT / 1e6).toLocaleString()} USDC — waiting for the keeper to credit it`);

  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    const c = await capital();
    if (c > 0) {
      console.log("capital after:", c.toLocaleString(), "USDC");
      if (c >= AMOUNT / 1e6) return;
    }
  }
  console.log("credit still pending — the keeper's deposit rail is permissionless, it will land");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("FAILED:", e?.msg ?? e?.message ?? e);
    process.exit(1);
  }
);
