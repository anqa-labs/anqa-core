# Anqa

**A perpetuals DEX whose order book lives inside a Private Ephemeral Rollup.**

> عنقاء — *known by name, unseen by eye.*

Every on-chain perps venue today publishes its book. That is why size gets hunted:
a public order book plus public positions means anyone can compute where a large
trader dies. Anqa keeps the guarantees and removes the exposure — a real central
limit order book, matching inside a TEE-backed rollup, where the only thing that
ever becomes public is the fill.

## What works today

Deployed to devnet at `4uLF3kQu9Hz93xKNThVdqV2H1EAdF1xy1xRKYzmi8T4j`.

- **Phoenix-style CLOB** — strict price-time priority, FIFO ordering, crankless
  execution (takers cross inside their own instruction; a fill is final when the
  transaction lands). Order types: Limit, PostOnly, IOC, FillOrKill. Self-trade
  prevention drops the resting order and keeps matching.
- **Zero-copy book** — `bytemuck` Pod accessed through `AccountLoader`. Not a
  preference: a borsh book blows Solana's 4KB BPF stack (the compiler reports
  ~10KB frames). Phoenix is zero-copy for this reason and so is Percolator.
- **Seats** — per-trader accounts, and the natural unit of read permission inside
  a private rollup.
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
