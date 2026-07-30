# Anqa

**A perpetuals DEX whose order book lives inside a Private Ephemeral Rollup.**

> عنقاء — *known by name, unseen by eye.*

Every on-chain perps venue today publishes its book. That is why size gets hunted:
a public order book plus public positions means anyone can compute where a large
trader dies. Anqa keeps the guarantees and removes the exposure — a real central
limit order book, matching inside a TEE-backed rollup, where the only thing that
ever becomes public is the fill.

## What works today — a working perp venue on devnet

Not a spot book with perp branding: fills mint **positions**, not token transfers.
The vault balance is provably unchanged across a trade.

```
[2] risk engine live — group 734B, asset slots 3887B, 20x max leverage
[4] maker/taker portfolios opened, 500,000 USDC deposited each
[6] taker crossed ASK 4 -> positions minted
    book: fill_count=1 last=4@65000 bids=1 asks=0
    vault after trade: 1000000 USDC (unchanged — a fill moves no tokens)
[7] crank: mark 65000 -> 64350, funding accrued
[8] liquidation refused: NonProgress (account healthy — correct)
```

## Architecture

Deployed to devnet at `4uLF3kQu9Hz93xKNThVdqV2H1EAdF1xy1xRKYzmi8T4j`.

- **Phoenix-style CLOB** — strict price-time priority, FIFO ordering, crankless
  execution (takers cross inside their own instruction; a fill is final when the
  transaction lands). Order types: Limit, PostOnly, IOC, FillOrKill. Self-trade
  prevention drops the resting order and keeps matching.
- **Zero-copy book** — `bytemuck` Pod accessed through `AccountLoader`. Not a
  preference: a borsh book blows Solana's 4KB BPF stack (the compiler reports
  ~10KB frames). Phoenix is zero-copy for this reason and so is Percolator.
- **Risk engine** — the [Percolator](https://github.com/anqa-labs/percolator)
  kernel (Apache-2.0, 244 Kani proofs) drives all margin, funding, PnL and
  liquidation. Anqa supplies what a kernel deliberately does not own: account
  loading, authorization, oracle authentication, custody, and matching.
- **Portfolios** — per-trader margin accounts (9.3KB of kernel state), also the
  trader's seat and the natural unit of read permission inside a private rollup.
- **Tokens move in exactly two instructions** — `deposit` and `withdraw`. Never
  on a fill. Withdrawal is strict by design: the kernel requires a flat account
  (no open positions), settles negative PnL out of principal first, and refuses
  to release anything it cannot prove is the trader's. Anqa additionally requires
  resting orders to be cancelled, since their reserved margin is bookkeeping the
  kernel cannot see. This is the visible end of *losses are senior, wins are
  junior*.
- **The mark price comes from Pyth, never from the caller.** `crank` is
  permissionless, so a cranker that could name its own price could mark every
  position wherever it liked and liquidate at will. Two gates guard the read:
  staleness (refuse prices older than the market's limit) and **confidence** —
  Pyth publishes an interval, and when it widens past `max_conf_bps` the market
  is disagreeing with itself, so we refuse to mark rather than mark on a number
  nobody trusts. The feed id is pinned at market creation, so a caller cannot
  substitute a different asset's oracle. Verified live on devnet against Pyth's
  sponsored BTC/USD feed.
- **Order margin is reserved at placement**, not only checked at fill — otherwise
  an account could paper the book with orders it cannot honour and fail only
  after the book was walked.
- **Delegation** — the book hands off to the ephemeral rollup validator, after
  which base-chain reads are frozen.

Verified end to end by `app/dry-run.ts`:

```
[1] market + book initialized        book account size: 4680 bytes
[2] seats claimed for maker and taker
[3] maker rested BID 10 @ 65000
[4] taker sent ASK 4 @ 65000 -> crossed
[6] fill_count: 1  last_fill: 4 @ 65000  bids resting: 1  asks resting: 0
[7] book owner is now: DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh
```

## Layout

```
programs/anqa-core/src/
├── lib.rs              program module — thin wiring only
├── constants.rs        seeds, capacities, sentinels
├── errors.rs
├── events.rs           the public tape: Fill carries price/size/seq and nothing else
├── state/
│   ├── market.rs       market config (base layer, never delegated)
│   ├── seat.rs         per-trader account and unit of read permission
│   └── book.rs         the CLOB: arenas, intrusive priority lists, matching
└── instructions/       one module per instruction
```

## What is deliberately not here yet

- **Margin, funding, liquidation.** These belong to the
  [Percolator](https://github.com/aeyakovenko/percolator) risk kernel, which this
  program will drive as its wrapper: the book decides *who trades at what price*,
  the kernel decides *whether they may* and what it does to their accounts.
  Integration validated separately in `anqa-labs/anqa-kernel-spike`.
- **Private rollup permissions.** Delegation works; the per-account read gating
  that makes the book genuinely dark (`CreateEphemeralPermissionCpi`) is next.
- **Maker-side settlement.** `place_order` credits the taker's seat. Makers are
  matched correctly but their seats are not credited in the same instruction —
  they are not passed as accounts. Needs either `remaining_accounts` for maker
  seats or a separate settlement step.
- Vault, insurance, ADL, builder codes, multi-market.

## Build

```bash
anchor build
solana program deploy target/deploy/anqa_core.so \
  --program-id target/deploy/anqa_core-keypair.json --url devnet
npx ts-node --transpile-only app/dry-run.ts
```

Toolchain: Anchor 0.32.1 (pinned — the last release before 1.x), Solana 3.1.x,
`ephemeral-rollups-sdk` 0.16.2.
