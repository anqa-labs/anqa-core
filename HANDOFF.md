# anqa — handoff (2026-08-02)

State of the work, for picking up in a fresh session.

## Where we are

The dark book is **real and verified**. This was the session's main result. Before
it, anqa's book was fully readable by anyone — I asserted otherwise, a test
disproved it, and the fix was built after a research pass on MagicBlock PER.

Verification that passed:

```
permission record on TEE: 567 bytes, private flag = 1
BOOK  read by a stranger (TEE): null      — HIDDEN
DEPTH read by a stranger (TEE): 432 bytes — readable
book on base layer: 6216 bytes (an old committed snapshot)
```

What actually hides an account: an **ephemeral** `EphemeralPermission` with
`private: true`, created *inside* the rollup, on an account delegated to the
**TEE validator** (`MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`). MagicBlock's
Query Filtering Service enforces it at RPC ingress. All three conditions must
hold together; the base-layer `create_permission` has no `private` flag at all,
which is what anqa had before.

Three caveats that are structural, not bugs:

1. Base-layer commits are plaintext. The book must never be committed —
   `commit_frequency_ms = u32::MAX` is what holds this. Do not "fix" it.
2. The permission record itself is public. Anyone can see *that* the book is
   private and *who* may read it. Only contents are hidden.
3. It is a **read filter, not an execution guard**. Every authorization rule
   (who may cancel, who may close) must stay in the program.

## Live venue

| | |
|---|---|
| hub / group | **900** |
| program | `4uLF3kQu9Hz93xKNThVdqV2H1EAdF1xy1xRKYzmi8T4j` |
| USDC mint | `6MSiVChQCdqTivQgmeFKrjaL621SCSSBAHHyberLAkQr` |
| ER RPC | `https://devnet-tee.magicblock.app` (TEE, filtered) |
| markets | 900–908 (BTC, SOL, ETH, XRP, DOGE, LINK, AVAX, SUI, BNB) |

`GROUP=900` is already set in `web/lib/markets.ts`. The site is **not yet
pointed at 900** — Vercel env vars still need updating and a deploy.

## Done this session (uncommitted — last commit was `53faede`)

- `programs/.../instructions/set_private.rs` — `set_book_private` /
  `set_portfolio_private`. The file the product rests on; read its header
  comment first.
- `programs/.../state/depth.rs` + `publish_depth.rs` — the public aggregate
  mirror (12 levels/side, price + size only, no owner, no order id). This is
  what makes a dark book tradeable rather than merely opaque.
- `app/tee-auth.ts` — challenge → ed25519 sign → JWT, appended as `?token=`.
  Signature must be **bs58**; base64 gives `401 failed to decode string to
  signature`.
- `web/lib/teeSession.ts` — the browser equivalent, cached in localStorage for
  the token's 30-day life. Degrades to anonymous reads if the wallet can't sign.
- `web/lib/useAnqa.ts` — ER connection is now token-aware (`useWallet()` for
  `signMessage`, token in a `useState`, `conns` memo keyed on it). `tsc` clean.
- `app/demo-maker.ts` — makers no longer read the book (see below).

## The thing that just broke, and why it was correct

Makers on hub 900 died with `Account does not exist or has no data
7CjRno5S…` — that account is the **book for market 904**. The makers aren't
members of the book's permission record (only the provisioning payer is,
`flags: 31`), so the filter returned null and Anchor read that as "missing".

That is the filter working. A market maker is a trader, not an operator, and
should not read the whole book — so the fix was to remove the maker's dependency
on it: it now reports published depth instead. **The maker has not been re-run
since this edit.** First thing to do: restart makers + keepers on 900 and
confirm orders rest and depth publishes.

## Update — 2026-08-04

**RPC fix is in and verified.** No paid endpoint. `app/rpc.ts` is a new
base-layer `Connection` that retries 429/5xx with jittered backoff and caps
in-flight requests per process; all twelve `app/*.ts` scripts now use it. The
keeper's requote watchdog backs off exponentially instead of respawning the
maker every 15s forever, and `run-keepers.sh` staggers launches 6s apart. After
restart: **zero 429s in any keeper log**, makers run to completion.

**Stale hub-890 values fixed**: `web/lib/markets.ts` mint → hub 900's
(`6MSiVCh…`, verified on chain, 6 decimals), and `web/.env.local` got
`MARKET_ID=900`, the right mint, and — the one nobody had caught —
`NEXT_PUBLIC_ER_RPC` moved off `devnet.magicblock.app` (shared, unfiltered)
onto `devnet-tee.magicblock.app`. Vercel still needs the same three.

**Hub 900 cannot trade, and it is not an RPC problem.** The percolator kernel
rejects `reanchor_oracle` *and* `crank` with `InvalidConfig` (`0x177a`):

```
Program log: anqa: risk engine rejected: InvalidConfig
```

Consequences, in order: `oracleState` for every market is all zeros (never
anchored) → mark is $0 → the maker computes its ladder off zero and rests
nothing → depth publishes 0/0 → the watchdog respawns forever. The internal
oracle *is* fresh (`publishTime` current, `lastKeeper` set), so relay and
push-feed are fine; the break is between the internal oracle and the mark.

### Diagnosed: the TEE rollup's clock runs *behind* base

Not a config mismatch. Everything checks out — config decodes as
`max_portfolio_assets = 4`, `max_market_slots = 9`, margins 250/500; the slabs
have exactly 9 of 12 slots initialized. The break is the clock.

```
base layer slot : 481,140,360
TEE rollup slot : 238,184,391      ← ~243M slots BEHIND base
risk header slot_last / current_slot: 481,132,376 / 481,132,442  (base frame)
```

`initialize_risk.rs:150` stamps `Clock::get()?.slot` on **base layer** into the
kernel header. The group is then delegated to the TEE validator, where every
kernel entry passes the *rollup's* slot. The kernel's shape invariant rejects
`slot_last > current_slot` with `InvalidConfig` — so 481M > 238M fails, and
every crank and reanchor on hub 900 has failed since delegation.

The cruel part: `reanchor_oracle` exists precisely to fix a clock mismatch, and
its own header comment says the rollup "reads ~28 million slots **ahead**". It
was built for the shared Asia validator, which ran ahead of base. The TEE
validator runs behind, so the escape hatch has to jump the clock *backward* —
which the same monotonicity invariant forbids. It fails with the identical
error. **Moving to the TEE validator for privacy is what introduced this**; it
is not a regression in any of the trading code.

### Fixed — the venue now owns its clock

`state/venue_clock.rs` is a per-group `VenueClock { venue_slot, last_raw,
frame_changes }`. Every kernel entry converts the host's reading into an
elapsed amount and adds it: forward → advance, capped at one accrual step;
backward → advance by nothing and re-baseline. Monotonic by construction, so
the kernel's invariant is *guaranteed* rather than relaxed. Wired into the four
instructions that feed the kernel a slot (`crank`, `reanchor_oracle`,
`activate_asset`, `sweep_backing`); the rest use wall-clock timestamps, which
are frame-independent.

Created on base, delegated with the risk group. Seeding from base's clock is
automatically ≥ whatever `initialize_risk` stamped, which is what let hub 900
be rescued in place — `app/rescue-clock.ts` did it, no re-provisioning and no
new mint.

Verified live on hub 900:

```
venue_slot 481,147,851   last_host 238,224,532   frame_changes 1
crank: 60 ticks, mark live      depth: 4 bid / 4 ask levels
InvalidConfig rejections since restart: 0
```

`frame_changes = 1` is the base→rollup jump being absorbed exactly once. Four
unit tests cover it (`cargo test -p anqa-core --lib venue_clock`), including
the adversarial-host case. All four instruction contexts were audited
separately for the seeds constraint binding the clock to `market.group_id` —
that is the one place a mistake would be exploitable.

Deployed: program extended by 60,000 bytes, redeployed, IDL regenerated with
`anchor idl build` (note: `cargo build-sbf` does **not** regenerate it) and
copied to `web/lib/`.

Superseded options, kept for the record:

1. **Emptiness-gated clock reset inside the rollup.** Generalize
   `reanchor_oracle` (or add a sibling) to re-stamp `slot_last`/`current_slot`
   to the rollup's clock in *either* direction, behind the existing
   `group_has_position_or_loss_state_for_oracle_reset` gate. Hub 900 has no
   positions, so this could rescue it **in place — no new mint, no re-funding
   the wallet.** Needs a percolator change (it is vendored) plus redeploy, and
   it touches a risk-engine invariant, so it deserves care.
2. Stamp slot 0 at init and let the first in-rollup crank establish the clock.
   Simpler, but a zero clock risks tripping the
   `asset_activation_count`/`last_asset_activation_slot` invariant, since asset
   activation happens during `initialize_risk`.
3. Move back to the shared validator. Restores trading immediately and throws
   away the private book. Not worth it.

Residual: websocket subscriptions still hit `429` (`ws error: Unexpected server
response: 429`) — the retry wrapper covers HTTP only. Non-fatal; it surfaces as
the familiar `Unknown action 'undefined'` on ER confirms.

## The deposit rail (2026-08-04)

A deposit is two halves: USDC into custody on base, then the rollup crediting
the portfolio from that ledger. Only the first is signed by the trader. The
second was left entirely to the browser — and when it failed, the terminal saw
no collateral and asked for the deposit *again*, taking another $10,000 out of
the wallet per click. Found live.

`claim_deposit` was always permissionless and idempotent — `actions.ts` even
calls it "the keeper rail... which is what makes this path always available" —
but **no keeper loop ever ran it**. Now one does (`keeper.ts`, lead keeper
only, every 6s): scan group ledgers, compare `deposited` against the
portfolio's `claimedHighWater`, claim only the difference.

Verified: credits when owed (both stranded deposits picked up automatically),
silent when not, and the high-water decode reads $20,000 against $20,000
deposited — so the silence is correctness, not a broken comparison.

Still unknown: why the *browser's* claim never lands. It is no longer a
correctness problem — the keeper covers it — but it is still a latency one, so
worth finding. `margin.ts:137` swallows the error in a bare `catch {}`, which
is why nobody could see it.

## Open items

1. **Restart makers/keepers on hub 900** and confirm depth is publishing.
2. **The same lockout applies to traders.** With the book private, the
   terminal's `myBids` / `myAsks` reads return null for everyone except the
   provisioner. Traders will see aggregate depth but *not their own resting
   orders*. Needs a decision: add each trader to the book's permission members
   (`update_ephemeral_permission`, disc 7), or track own-orders client-side from
   the tape, or give each trader a per-owner order index account they can read.
   This is the last real gap before the terminal is honest on 900.
3. Point Vercel at hub 900, redeploy.
4. `set_portfolio_private` exists but **nothing calls it**. Hiding a trader's
   position and liquidation price is the privacy that costs nobody anything —
   worth wiring.
5. **Commit and push.** Everything since `53faede` is uncommitted, including all
   the private-book work.
6. Discussed, not started: block-trade mode (fully dark above a size threshold).

## Hard-won gotchas, so they aren't rediscovered

- One account per `commit_and_undelegate` bundle. Two-account bundles strand
  accounts (this ate hub 820).
- Always `skipPreflight: true` on ER sends — simulation shows stale ownership.
- `"Unknown action 'undefined'"` from Anchor `.rpc()` on ER is the websocket
  confirm step, not the send. Raw `sendTransaction` works.
- After rebuilding the program, **copy `target/idl/anqa_core.json` →
  `web/lib/anqa_core.json`**. A stale IDL makes the frontend think accounts
  don't exist and try to recreate them.
- `bytemuck::Pod` rejects implicit padding — group `u8` fields after `u64`s with
  explicit tail padding.
- 10,240-byte cap on CPI account creation/realloc; `solana program extend` when
  the binary outgrows its allocation.
- Never take the keepers down without telling the user first. Doing so mid-session
  broke a live close for them.
