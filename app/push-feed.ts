/**
 * Push Pyth price updates for feeds nobody else keeps fresh on devnet.
 *
 * BTC and SOL have sponsored pushers; the long-tail listings do not — their
 * transient posts age out and `PriceTooOld` refuses every activation and
 * relay. This pushes verified Hermes updates to each feed's **fixed shard-0
 * price-feed PDA** (the same mechanism behind the sponsored accounts), so
 * every market gets a stable feed address that stays fresh as long as this
 * runs.
 *
 * One shot:   npx ts-node --transpile-only app/push-feed.ts
 * As a loop:  ANQA_PUSH_LOOP_SECS=300 npx ts-node --transpile-only app/push-feed.ts
 */

import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { Connection, Keypair } from "@solana/web3.js";
import { baseConnection } from "./rpc";
import { Wallet } from "@coral-xyz/anchor";
import fs from "fs";
import os from "os";
import path from "path";

const RPC = process.env.ANQA_RPC ?? "https://api.devnet.solana.com";
const SHARD = 0;

/** feed hexes that need a pusher (no devnet sponsor). */
const FEEDS: Record<string, string> = {
  XRP: "ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8",
  DOGE: "dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c",
  LINK: "8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221",
  AVAX: "93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7",
  SUI: "23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744",
  BNB: "2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
};

const now = () => new Date().toISOString().slice(11, 19);

async function pushOnce(receiver: PythSolanaReceiver, hermes: HermesClient) {
  const ids = Object.values(FEEDS);
  const { binary } = await hermes.getLatestPriceUpdates(ids, { encoding: "base64" });

  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
  await builder.addUpdatePriceFeed(binary.data, SHARD);
  const txs = await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: 50_000,
  });
  await receiver.provider.sendAll(txs, { skipPreflight: true });
  console.log(`${now()}  pushed ${ids.length} feeds to shard ${SHARD}`);
}

async function main() {
  const conn = baseConnection(RPC);
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))
    )
  );
  const receiver = new PythSolanaReceiver({ connection: conn, wallet: new Wallet(payer) });

  for (const [sym, hex] of Object.entries(FEEDS)) {
    const addr = receiver.getPriceFeedAccountAddress(SHARD, hex);
    console.log(`${sym.padEnd(5)} ${addr.toBase58()}`);
  }

  const hermes = new HermesClient("https://hermes.pyth.network");
  const loopSecs = Number(process.env.ANQA_PUSH_LOOP_SECS ?? 0);

  await pushOnce(receiver, hermes);
  while (loopSecs > 0) {
    await new Promise((r) => setTimeout(r, loopSecs * 1000));
    try {
      await pushOnce(receiver, hermes);
    } catch (e: any) {
      console.log(`${now()}  push failed: ${String(e?.message ?? e).slice(0, 100)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
