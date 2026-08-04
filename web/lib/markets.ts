/**
 * The venue's market registry.
 *
 * Every market is a self-contained PDA family keyed by its id — its own book,
 * oracle and tape; margin, custody and risk live in the shared cross-margin
 * hub. This file is the one place the frontend learns what exists: ids,
 * symbols, feeds and display shapes. The hub mint comes from the provisioning
 * run (`app/.demo-mint-<group>.json`).
 */

export type MarketInfo = {
  id: number;
  /** The cross-margin hub this market belongs to (= first market's id).
   *  One vault, one risk engine, one portfolio per trader, shared. */
  groupId: number;
  /** This market's asset slot inside the shared risk group. */
  assetIndex: number;
  /** Venue ticker, e.g. "BTC-PERP". */
  symbol: string;
  /** Base asset for labels and size units. */
  base: string;
  /** Pyth feed id (hex) — streamed from Hermes for the live index. */
  pythFeedId: string;
  /** Pyth benchmarks symbol for historical candles. */
  pythSymbol: string;
  /** TradingView chart symbol. */
  tvSymbol: string;
  /** This market's devnet collateral mint. */
  mint: string;
  /** Display decimals for sizes in the base asset. */
  sizeDp: number;
  /** Whole base assets per lot (mirrors on-chain config; may exceed 1). */
  lotFrac: number;
  /** Quote atoms per tick (mirrors on-chain config). */
  tick: number;
};

/**
 * Hub 900's shared collateral mint (from `app/.demo-mint-900.json`).
 *
 * This tracks GROUP — a stale mint here points the terminal at the right
 * markets with the wrong collateral, which fails at deposit rather than at
 * load, so it is worth changing both in the same edit.
 */
const HUB_MINT = "6MSiVChQCdqTivQgmeFKrjaL621SCSSBAHHyberLAkQr";

const GROUP = 900;

export const MARKETS: MarketInfo[] = [
  {
    id: GROUP,
    groupId: GROUP,
    assetIndex: 0,
    symbol: "BTC-PERP",
    base: "BTC",
    pythFeedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    pythSymbol: "Crypto.BTC/USD",
    tvSymbol: "PYTH:BTCUSD",
    mint: HUB_MINT,
    sizeDp: 4,
    lotFrac: 0.001,
    tick: 1_000,
  },
  {
    id: GROUP + 1,
    groupId: GROUP,
    assetIndex: 1,
    symbol: "SOL-PERP",
    base: "SOL",
    pythFeedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    pythSymbol: "Crypto.SOL/USD",
    tvSymbol: "PYTH:SOLUSD",
    mint: HUB_MINT,
    sizeDp: 1,
    lotFrac: 0.1,
    tick: 1_000,
  },
  {
    id: GROUP + 2,
    groupId: GROUP,
    assetIndex: 2,
    symbol: "ETH-PERP",
    base: "ETH",
    pythFeedId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    pythSymbol: "Crypto.ETH/USD",
    tvSymbol: "PYTH:ETHUSD",
    mint: HUB_MINT,
    sizeDp: 2,
    lotFrac: 0.01,
    tick: 1_000,
  },
  {
    id: GROUP + 3,
    groupId: GROUP,
    assetIndex: 3,
    symbol: "XRP-PERP",
    base: "XRP",
    pythFeedId: "ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8",
    pythSymbol: "Crypto.XRP/USD",
    tvSymbol: "PYTH:XRPUSD",
    mint: HUB_MINT,
    sizeDp: 0,
    lotFrac: 10,
    tick: 1_000,
  },
  {
    id: GROUP + 4,
    groupId: GROUP,
    assetIndex: 4,
    symbol: "DOGE-PERP",
    base: "DOGE",
    pythFeedId: "dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c",
    pythSymbol: "Crypto.DOGE/USD",
    tvSymbol: "PYTH:DOGEUSD",
    mint: HUB_MINT,
    sizeDp: 0,
    lotFrac: 100,
    tick: 1_000,
  },
  {
    id: GROUP + 5,
    groupId: GROUP,
    assetIndex: 5,
    symbol: "LINK-PERP",
    base: "LINK",
    pythFeedId: "8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221",
    pythSymbol: "Crypto.LINK/USD",
    tvSymbol: "PYTH:LINKUSD",
    mint: HUB_MINT,
    sizeDp: 0,
    lotFrac: 1,
    tick: 1_000,
  },
  {
    id: GROUP + 6,
    groupId: GROUP,
    assetIndex: 6,
    symbol: "AVAX-PERP",
    base: "AVAX",
    pythFeedId: "93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7",
    pythSymbol: "Crypto.AVAX/USD",
    tvSymbol: "PYTH:AVAXUSD",
    mint: HUB_MINT,
    sizeDp: 0,
    lotFrac: 1,
    tick: 1_000,
  },
  {
    id: GROUP + 7,
    groupId: GROUP,
    assetIndex: 7,
    symbol: "SUI-PERP",
    base: "SUI",
    pythFeedId: "23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744",
    pythSymbol: "Crypto.SUI/USD",
    tvSymbol: "PYTH:SUIUSD",
    mint: HUB_MINT,
    sizeDp: 0,
    lotFrac: 10,
    tick: 1_000,
  },
  {
    id: GROUP + 8,
    groupId: GROUP,
    assetIndex: 8,
    symbol: "BNB-PERP",
    base: "BNB",
    pythFeedId: "2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f",
    pythSymbol: "Crypto.BNB/USD",
    tvSymbol: "PYTH:BNBUSD",
    mint: HUB_MINT,
    sizeDp: 1,
    lotFrac: 0.1,
    tick: 1_000,
  },
];

export const DEFAULT_MARKET_ID = Number(process.env.NEXT_PUBLIC_MARKET_ID ?? GROUP);

export function marketById(id: number): MarketInfo {
  return MARKETS.find((m) => m.id === id) ?? MARKETS[0];
}
