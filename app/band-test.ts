/**
 * Focused test: can two accounts trade at an off-market price?
 *
 * This is the attack that separates a perp CLOB from a spot one. On a spot
 * venue, trading at price 1 just means you sold cheap with your own tokens. On
 * a perp venue it mints a position at that entry, the mark instantly revalues
 * it, and the loser's shortfall becomes bad debt against the vault.
 *
 * The risk kernel does not check this — it only rejects zero and absurd
 * prices — so the band is the wrapper's job.
 *
 * Run: npx ts-node --transpile-only app/band-test.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("4uLF3kQu9Hz93xKNThVdqV2H1EAdF1xy1xRKYzmi8T4j");
const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";

const BTC_FEED_HEX = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const BTC_FEED_ACCOUNT = new PublicKey("4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo");

const MARKET_ID = new BN(Date.now() % 1_000_000);
const BAND_BPS = 500; // 5%

const S = (x: string) => Buffer.from(x);
const le8 = (n: BN) => n.toArrayLike(Buffer, "le", 8);

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))
    )
  );
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync("target/idl/anqa_core.json", "utf-8"));
  const program: any = new Program(idl, provider);

  const pda = (seed: string, extra: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([S(seed), le8(MARKET_ID), ...extra], PROGRAM_ID)[0];
  const market = pda("anqa_market");
  const book = pda("anqa_book");
  const riskGroup = pda("anqa_risk");
  const assetSlots = pda("anqa_assets");
  const oracleState = pda("anqa_oracle");
  const portfolio = pda("anqa_portfolio", [payer.publicKey.toBuffer()]);

  console.log("\n=== OFF-MARKET TRADE TEST ===");

  const oracleParams = {
    feedId: Array.from(Buffer.from(BTC_FEED_HEX, "hex")),
    secondaryFeedId: Array(32).fill(0),
    maxAgeSecs: new BN(120),
    maxConfBps: 200,
    maxDeviationBps: 100,
    maxMoveBpsPerInterval: 0, // no band on the mark itself for this test
    freezeSlots: new BN(150),
    emaWeightBps: 2000,
    maxBandBps: BAND_BPS,
    maxMarkStalenessSlots: new BN(10_000),
  };

  await program.methods
    .initializeMarket(MARKET_ID, new BN(1), new BN(1), 8, 6, 0, 0, { pyth: {} }, oracleParams)
    .accounts({
      authority: payer.publicKey,
      market,
      book,
      oracleState,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  await program.methods
    .initializeRisk(MARKET_ID, 1)
    .accounts({
      authority: payer.publicKey,
      market,
      riskGroup,
      assetSlots,
      priceUpdate: BTC_FEED_ACCOUNT,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  await program.methods
    .openPortfolio()
    .accounts({ trader: payer.publicKey, market, portfolio, systemProgram: SystemProgram.programId })
    .rpc();

  // Crank once so the oracle state holds a live mark.
  await program.methods
    .crank(0, new BN(0))
    .accounts({
      cranker: payer.publicKey,
      market,
      riskGroup,
      assetSlots,
      oracleState,
      priceUpdate: BTC_FEED_ACCOUNT,
    })
    .rpc();

  const os_ = await program.account.oracleState.fetch(oracleState);
  const mark = Number(os_.lastPrice);
  console.log(`mark: ${mark} quote atoms ($${(mark / 1e6).toLocaleString()})`);
  console.log(`band: ${BAND_BPS}bps -> [${Math.floor(mark * 0.95)}, ${Math.floor(mark * 1.05)}]\n`);

  const place = (price: number, label: string, shouldPass: boolean) =>
    program.methods
      .placeOrder({ bid: {} }, { limit: {} }, new BN(price), new BN(1), new BN(price % 1000))
      .accounts({
        trader: payer.publicKey,
        market,
        book,
        riskGroup,
        assetSlots,
        oracleState,
        portfolio,
      })
      .rpc()
      .then(() => {
        console.log(shouldPass ? `PASS  ${label} -> accepted` : `FAIL  ${label} -> ACCEPTED (hole open)`);
      })
      .catch((e: any) => {
        const logs: string[] = e.logs ?? [];
        const hit = logs.find((l) => l.includes("Error Message"));
        const reason = (hit ?? e.message).replace(/^Program log: /, "").trim();
        const banded = reason.includes("PriceOutsideBand");
        // This account holds no collateral, so an order that clears the band
        // then fails on margin has still proven what we are testing here.
        const clearedBand = reason.includes("InsufficientMargin");
        if (shouldPass) {
          console.log(
            clearedBand
              ? `PASS  ${label} -> cleared the band (then hit margin, as expected with no collateral)`
              : `FAIL  ${label} -> ${reason}`
          );
        } else {
          console.log(banded ? `PASS  ${label} -> refused on band` : `FAIL  ${label} -> ${reason}`);
        }
      });

  // The attack: rest a bid at 1 while BTC is worth 64,000.
  await place(1, "bid @ 1 (the attack)", false);
  // Just outside the band.
  await place(Math.floor(mark * 0.9), "bid 10% below mark", false);
  // Inside the band — must still work, or we broke trading.
  await place(Math.floor(mark * 0.99), "bid 1% below mark", true);

  console.log("");
}

main().catch((e) => {
  console.error(e.logs ?? e);
  process.exit(1);
});
