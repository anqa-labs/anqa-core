import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/Wordmark";

export const metadata: Metadata = {
  title: "Docs — Anqa",
  description:
    "How to trade on Anqa and how its private ephemeral rollup, dark order book, Percolator risk engine, session keys, custody and settlement work.",
};

const NAV = [
  ["start", "Start here"],
  ["quickstart", "Use the protocol"],
  ["perps", "Perpetuals 101"],
  ["terminal", "Terminal guide"],
  ["orders", "Orders & fills"],
  ["per", "Private rollup"],
  ["privacy", "Privacy model"],
  ["architecture", "Architecture"],
  ["lifecycle", "Trade lifecycle"],
  ["risk", "Percolator risk"],
  ["oracles", "Oracles & funding"],
  ["sessions", "Session keys"],
  ["keepers", "Keeper & maker"],
  ["withdrawals", "Close & withdraw"],
  ["proof", "Verify the claims"],
  ["troubleshooting", "Troubleshooting"],
  ["glossary", "Glossary"],
] as const;

const ORDER_TYPES = [
  {
    name: "Market",
    behaviour:
      "Sends an immediate-or-cancel order through the available book. It fills at resting maker prices, not necessarily at the displayed mark.",
    use: "Opening or closing now when execution matters more than an exact price.",
  },
  {
    name: "Limit · GTC",
    behaviour:
      "Crosses immediately when marketable; otherwise the unfilled amount rests until it fills or you cancel it.",
    use: "Naming the worst price you will accept and allowing the order to wait.",
  },
  {
    name: "Post only",
    behaviour:
      "Must add liquidity. If it would cross an existing order, the protocol rejects it instead.",
    use: "Guaranteeing that you are a maker rather than a taker.",
  },
  {
    name: "IOC",
    behaviour:
      "Fills whatever is immediately available at or better than your limit, then discards the remainder.",
    use: "Taking available liquidity without leaving anything resting.",
  },
  {
    name: "FOK",
    behaviour:
      "The entire requested size must be available immediately inside your limit or nothing is matched.",
    use: "Avoiding partial execution.",
  },
];

const GLOSSARY = [
  [
    "Base layer",
    "Solana devnet in the current deployment: custody, permanent configuration, session grants and withdrawals.",
  ],
  [
    "PER",
    "Private Ephemeral Rollup: the fast, access-controlled execution environment holding delegated live trading state.",
  ],
  [
    "Percolator",
    "The embedded perpetual-futures risk kernel that owns margin, positions, PnL, funding and liquidation accounting.",
  ],
  [
    "Portfolio",
    "A trader's private margin account. One portfolio serves the whole market group and contains capital, positions and triggers.",
  ],
  [
    "Mark",
    "The protocol's accepted oracle price, used for risk and PnL. It is not a promise that an order executes at that price.",
  ],
  [
    "Index",
    "The external reference price streamed from Pyth before the protocol applies its acceptance policy.",
  ],
  [
    "Tick",
    "The integer price increment stored by the book. The UI converts ticks into trader-facing USD prices.",
  ],
  [
    "Lot",
    "The minimum base-size increment for a market. BTC currently uses 0.001 BTC per lot; other assets use their registry value.",
  ],
  ["Maker", "A trader whose resting order supplies the execution price."],
  ["Taker", "A trader whose incoming order crosses resting liquidity."],
  [
    "Tape",
    "The public feed of settled price, size and time. It intentionally omits identities and aggressor side.",
  ],
  [
    "Depth mirror",
    "A public aggregate of shown liquidity by price. Hidden orders are excluded; identities never appear.",
  ],
  [
    "Delegation",
    "Moving an account's live execution authority from Solana to the ephemeral rollup while retaining its program rules.",
  ],
  [
    "Settlement",
    "Applying a matched long/short pair to both portfolios through Percolator and printing the accepted fill.",
  ],
  [
    "Reserved margin",
    "Free equity held aside when an order rests or waits for settlement, so the same collateral cannot back many promises.",
  ],
  [
    "Session key",
    "A browser-generated, time-limited key authorized to trade but not to move custody funds.",
  ],
] as const;

export default function DocsPage() {
  return (
    <div className="min-h-dvh bg-void text-text">
      <header className="sticky top-0 z-40 h-14 border-b border-line-soft bg-void/90 backdrop-blur-xl">
        <div className="mx-auto flex h-full max-w-[1440px] items-center gap-5 px-4 md:px-6">
          <Link href="/" aria-label="Anqa home">
            <Wordmark />
          </Link>
          <span className="hidden h-5 w-px bg-line md:block" />
          <span className="text-[12px] font-medium text-muted">
            Documentation
          </span>
          <div className="ml-auto flex items-center gap-2">
            <a
              href="https://github.com/anqa-labs/anqa-core"
              target="_blank"
              rel="noreferrer"
              className="hidden h-8 items-center rounded-md border border-line px-3 text-[11px] text-muted transition-colors hover:border-phoenix-soft hover:text-bright sm:flex"
            >
              Source ↗
            </a>
            <Link
              href="/trade"
              className="flex h-8 items-center rounded-md bg-phoenix px-3 text-[11px] font-semibold text-void transition-[filter] hover:brightness-110"
            >
              Open terminal
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1440px] grid-cols-1 lg:grid-cols-[230px_minmax(0,900px)] lg:justify-center lg:gap-12 xl:grid-cols-[250px_minmax(0,940px)]">
        <aside className="hidden border-r border-line-soft px-4 py-10 lg:block">
          <nav
            className="sticky top-24 flex flex-col gap-0.5"
            aria-label="Documentation sections"
          >
            <span className="mb-3 px-3 text-[9px] font-semibold uppercase tracking-[0.16em] text-dim">
              On this page
            </span>
            {NAV.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                className="rounded-md px-3 py-1.5 text-[11px] text-dim transition-colors hover:bg-raised/60 hover:text-bright"
              >
                {label}
              </a>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 px-5 pb-28 pt-12 md:px-8 lg:px-0 lg:pt-16">
          <details className="mb-8 rounded-lg border border-line-soft bg-ink p-3 lg:hidden">
            <summary className="cursor-pointer text-[11px] font-medium text-bright">
              Browse documentation
            </summary>
            <nav className="mt-3 grid grid-cols-2 gap-1 border-t border-line-soft pt-3">
              {NAV.map(([id, label]) => (
                <a
                  key={id}
                  href={`#${id}`}
                  className="rounded px-2 py-1.5 text-[10px] text-muted hover:bg-raised hover:text-bright"
                >
                  {label}
                </a>
              ))}
            </nav>
          </details>

          <section
            id="start"
            className="scroll-mt-24 border-b border-line-soft pb-14"
          >
            <div className="mb-5 flex flex-wrap items-center gap-2">
              <Badge tone="gold">Devnet guide</Badge>
              <Badge>Protocol + terminal</Badge>
              <Badge>Updated for hub 930</Badge>
            </div>
            <h1 className="max-w-[780px] text-4xl font-medium leading-[1.08] tracking-[-0.04em] text-bright md:text-6xl">
              From wallet connection to private perp settlement.
            </h1>
            <p className="mt-6 max-w-[760px] text-[16px] leading-7 text-muted md:text-[18px] md:leading-8">
              Anqa is a perpetual-futures exchange whose live book and trader
              portfolios execute inside a Private Ephemeral Rollup. This guide
              explains how to use the terminal, what the protocol guarantees,
              what remains public, and where the trust boundaries actually are.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/trade"
                className="rounded-lg bg-phoenix px-4 py-2.5 text-[12px] font-semibold text-void hover:brightness-110"
              >
                Trade on devnet
              </Link>
              <a
                href="#quickstart"
                className="rounded-lg border border-line px-4 py-2.5 text-[12px] text-text hover:border-phoenix-soft"
              >
                Read the quick start ↓
              </a>
            </div>
            <div className="mt-10 grid gap-px overflow-hidden rounded-xl border border-line-soft bg-line-soft sm:grid-cols-4">
              <Metric value="9" label="perpetual markets" />
              <Metric value="USDC" label="shared collateral" />
              <Metric value="1" label="wallet session grant" />
              <Metric value="10s" label="devnet resting window" />
            </div>
          </section>

          <Callout title="Use test funds only" tone="warn">
            The current deployment is on Solana devnet. “USDC” in the terminal
            is faucet-issued test collateral with no monetary value. The
            resident maker and delayed auto-matcher are test infrastructure, not
            a promise about production liquidity.
          </Callout>

          <Section
            id="quickstart"
            kicker="Use the protocol"
            title="Open your first position"
            intro="The first interaction establishes custody, privacy and a trade-only browser session. After that, opening, cancelling and closing positions does not require wallet popups."
          >
            <div className="space-y-3">
              <Step n="01" title="Connect a Solana devnet wallet">
                Use the wallet button in the top-right. The wallet remains the
                only authority allowed to deposit, withdraw, grant a session or
                revoke one.
              </Step>
              <Step n="02" title="Get test USDC">
                Open <Strong>Deposit</Strong>, select the deposit tab and press{" "}
                <Strong>Get test USDC</Strong>. The faucet sends the current
                hub&apos;s test mint to your wallet.
              </Step>
              <Step n="03" title="Deposit into your trading account">
                Enter an amount and approve the wallet transaction. Base-layer
                USDC moves into the custody vault; the keeper credits the
                monotonic deposit ledger into your private portfolio.
              </Step>
              <Step n="04" title="Enable one-click trading">
                The onboarding transaction opens and permission-protects your
                portfolio, delegates it to the rollup, and grants the
                browser&apos;s session key. A grant lasts up to seven days and
                works across all markets.
              </Step>
              <Step n="05" title="Choose a market and direction">
                Pick BTC, SOL, ETH, XRP, DOGE, LINK, AVAX, SUI or BNB. Select{" "}
                <Strong>Long</Strong> if you expect the price to rise, or{" "}
                <Strong>Short</Strong> if you expect it to fall.
              </Step>
              <Step
                n="06"
                title="Choose collateral, leverage and order behaviour"
              >
                Collateral is the amount allocated behind this asset&apos;s
                position. Position value is approximately collateral × leverage,
                rounded to the market&apos;s lot size. Review the estimated
                liquidation price before submitting.
              </Step>
              <Step n="07" title="Watch the canonical result">
                A marketable order first shows as <Strong>Matching</Strong>,
                then becomes a position only after the settlement keeper updates
                the private portfolio. A non-marketable limit appears under
                <Strong> Resting orders</Strong> until it trades or is
                cancelled.
              </Step>
            </div>
            <Callout title="Current devnet matching behaviour">
              To make testing predictable, an unchanged user order that remains
              on a book is given at least ten seconds in the Resting Orders
              terminal, then the funded test maker submits the exact opposite
              IOC. Cancelling or amending the order removes or restarts that
              timer. Normal marketable orders can still fill immediately against
              displayed venue liquidity.
            </Callout>
          </Section>

          <Section
            id="perps"
            kicker="Perpetuals 101"
            title="What you are trading"
            intro="A perpetual future is a leveraged contract that tracks an asset's price without giving you the asset and without an expiry date. Anqa positions are accounting entries between a long and a short; BTC, SOL or ETH never moves through the venue."
          >
            <div className="grid gap-4 md:grid-cols-2">
              <InfoCard eyebrow="Long" title="Profit when the mark rises">
                A long&apos;s unrealized PnL is approximately (current mark −
                entry price) × position size. It loses when the mark falls.
              </InfoCard>
              <InfoCard eyebrow="Short" title="Profit when the mark falls">
                A short reverses that calculation: (entry price − current mark)
                × position size. It loses when the mark rises.
              </InfoCard>
            </div>
            <div className="mt-5 rounded-xl border border-line-soft bg-ink p-5">
              <h3 className="text-[13px] font-semibold text-bright">
                A simple leverage example
              </h3>
              <p className="mt-2 text-[12px] leading-6 text-muted">
                Allocate $100 at 10× and the target position value is about
                $1,000. A 1% favourable move produces roughly $10 of PnL before
                configured fees and funding—about 10% on the $100 allocation. A
                1% adverse move loses roughly the same amount. Leverage
                multiplies return on collateral in both directions; it does not
                change the underlying price move.
              </p>
            </div>
            <DocTable
              heads={["Field", "Meaning"]}
              rows={[
                [
                  "Collateral",
                  "The dollar allocation recorded behind this asset's position and its isolated liquidation budget.",
                ],
                [
                  "Leverage",
                  "Target notional divided by the collateral entered on the ticket.",
                ],
                [
                  "Position size",
                  "The resulting base-asset quantity after rounding down to whole protocol lots.",
                ],
                [
                  "Entry",
                  "The volume-weighted execution price of the settled position.",
                ],
                [
                  "Mark",
                  "The accepted oracle price used to value the position and judge risk.",
                ],
                [
                  "PnL",
                  "Unrealized gain or loss from entry to mark, plus protocol accounting such as funding when enabled.",
                ],
                [
                  "ROE",
                  "PnL divided by allocated margin, expressed as a percentage.",
                ],
                [
                  "Liquidation price",
                  "An estimate of where the position's collateral no longer covers its loss and maintenance requirement.",
                ],
              ]}
            />
            <Callout title="Liquidation is not a stop loss" tone="warn">
              A stop loss is a user-selected reduce-only exit. Liquidation is
              the protocol&apos;s solvency backstop and may execute after
              collateral has already been consumed by loss and maintenance
              margin. Use position sizing and a stop loss; do not treat the
              liquidation estimate as an execution target.
            </Callout>
          </Section>

          <Section
            id="terminal"
            kicker="Interface"
            title="Read the terminal"
            intro="The UI separates public market information, your authenticated private state and explicit custody actions."
          >
            <DocTable
              heads={["Area", "What it means", "Visibility"]}
              rows={[
                [
                  "Market bar",
                  "Mark, 24h range/change, open interest, fill count and resting totals.",
                  "Public aggregates",
                ],
                [
                  "Chart",
                  "External candles plus Anqa fill markers, your position entry and estimated liquidation line.",
                  "Mixed public/private",
                ],
                [
                  "Order book",
                  "Aggregated shown prices and totals. Hidden orders are excluded; owners never appear.",
                  "Public mirror",
                ],
                [
                  "Trades",
                  "Settled price, size and time from the fill tape.",
                  "Public, anonymous",
                ],
                [
                  "Trade ticket",
                  "Direction, collateral, leverage, price, order type, TP/SL and visibility.",
                  "Local + authenticated",
                ],
                [
                  "Positions",
                  "Your size, entry, mark, PnL, ROE, margin and close action across all markets.",
                  "Private to members",
                ],
                [
                  "Resting orders",
                  "Only your live orders, including whether each is shown or hidden.",
                  "Private owner mirror",
                ],
                [
                  "Account",
                  "Wallet balance, portfolio equity, allocated margin and custody controls.",
                  "Private + base custody",
                ],
                [
                  "Proof",
                  "Anonymous RPC probes and TEE attestation evidence.",
                  "Public verification",
                ],
              ]}
            />
            <div className="grid gap-3 md:grid-cols-3">
              <MiniCard title="Mark is not execution">
                The mark drives risk and previews. Your actual entry is the
                resting maker price recorded by the fill.
              </MiniCard>
              <MiniCard title="Orders are not positions">
                A resting or pending order reserves margin, but the position row
                appears only after successful settlement.
              </MiniCard>
              <MiniCard title="Portfolio value is not wallet balance">
                Wallet USDC is outside custody; portfolio equity is inside the
                trading account. Deposit and withdraw bridge them.
              </MiniCard>
            </div>
          </Section>

          <Section
            id="orders"
            kicker="Execution"
            title="Orders, visibility and fills"
            intro="Anqa keeps central-limit-order-book semantics: strict price-time priority, partial fills, real counterparties and self-trade prevention. Privacy changes who can inspect the queue; it does not change queue fairness."
          >
            <div className="overflow-hidden rounded-xl border border-line-soft">
              {ORDER_TYPES.map((order, i) => (
                <div
                  key={order.name}
                  className={`grid gap-2 p-4 md:grid-cols-[130px_1fr_1fr] ${
                    i ? "border-t border-line-soft" : ""
                  }`}
                >
                  <span className="text-[12px] font-semibold text-bright">
                    {order.name}
                  </span>
                  <p className="text-[12px] leading-5 text-text">
                    {order.behaviour}
                  </p>
                  <p className="text-[12px] leading-5 text-dim">{order.use}</p>
                </div>
              ))}
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <InfoCard
                eyebrow="Shown resting order"
                title="Included in aggregate depth"
              >
                Other traders may see total shown size at its price, but never
                the owner. You retain normal price-time priority and see the
                identifiable row only in your own Resting Orders tab.
              </InfoCard>
              <InfoCard
                eyebrow="Hidden resting order"
                title="Excluded from aggregate depth"
              >
                The order remains in the same matching queue with the same
                priority and margin requirement. It becomes public only as an
                anonymous tape print after settlement. Hiding buys no priority
                and costs no priority.
              </InfoCard>
            </div>
            <Callout
              title="Why a submitted order can appear to disappear"
              tone="neutral"
            >
              An incoming order may match immediately and leave the resting book
              before settlement. The UI shows it as Matching while the fill is
              pending. If the oracle band or Percolator refuses settlement, the
              queue entry is consumed and any unsafe maker remainder is
              cancelled so one bad fill cannot block every fill behind it. Only
              the private portfolio is authoritative evidence that a position
              opened.
            </Callout>
            <p className="mt-4 text-[11px] leading-5 text-dim">
              Market configuration also carries taker-fee and maker-rebate
              fields. The configured taker fee is applied during risk
              settlement; devnet parameters may be zero or change between test
              hubs. Read the deployed market configuration rather than assuming
              a production fee schedule.
            </p>
          </Section>

          <Section
            id="per"
            kicker="PER"
            title="What a Private Ephemeral Rollup does"
            intro="A PER is a temporary, high-speed execution environment for selected Solana accounts. It is not a second public blockchain and it is not a conventional gossip network where every peer receives every byte."
          >
            <div className="grid gap-3 md:grid-cols-3">
              <Concept n="1" title="Delegate">
                Program accounts such as the book, portfolios and risk state are
                handed to the MagicBlock delegation program. Base-chain
                configuration and custody remain on Solana.
              </Concept>
              <Concept n="2" title="Execute">
                The sequencer executes the same Solana program instructions at
                rollup latency. Private account reads are filtered by permission
                membership; writes still obey program authorization and PDA
                constraints.
              </Concept>
              <Concept n="3" title="Commit">
                Rollup state can be checkpointed back to Solana. Anqa refuses to
                commit a portfolio with open exposure, because publishing that
                snapshot would reveal position and liquidation information.
              </Concept>
            </div>
            <h3 className="mt-8 text-lg font-medium text-bright">
              Why running your own RPC does not reveal the live book
            </h3>
            <p className="mt-3 text-[13px] leading-6 text-text">
              A normal Solana RPC can serve only the last base-layer state. The
              current book lives in the delegated rollup account, not in
              Solana&apos;s peer-to-peer ledger stream. A rollup replica is a
              client of the primary validator and reaches private state through
              the same authenticated ingress; it does not receive an
              unrestricted gossip copy. Without a valid membership token, the
              private account query returns null.
            </p>
            <Callout
              title="Important distinction: access control, not ciphertext"
              tone="warn"
            >
              Book and portfolio bytes are plaintext while the matching program
              operates on them. Privacy comes from account permissions enforced
              by a TEE-backed validator and from remote attestation of that
              validator—not from zero-knowledge proofs, threshold encryption or
              encrypted matching. The matching environment can process the data;
              unauthorized RPC clients should not receive it.
            </Callout>
          </Section>

          <Section
            id="privacy"
            kicker="Threat model"
            title="What is private, what is public, and who is trusted"
            intro="The protocol deliberately publishes enough to establish a market while withholding trader identity and live exposure."
          >
            <DocTable
              heads={["Data", "Public reader", "Portfolio owner / engine"]}
              rows={[
                ["Market configuration", "Readable", "Readable"],
                ["Pyth index and accepted mark", "Readable", "Readable"],
                [
                  "Shown aggregate depth",
                  "Readable by price total",
                  "Readable",
                ],
                [
                  "Hidden aggregate depth",
                  "Not counted",
                  "Engine can match it",
                ],
                [
                  "Full book and order owners",
                  "RPC returns null",
                  "Engine reads; owner sees own mirror",
                ],
                [
                  "Position, entry, margin and PnL",
                  "RPC returns null while private/delegated",
                  "Owner and keeper members read",
                ],
                [
                  "Settled fill",
                  "Price, size, time",
                  "Same public print plus private account changes",
                ],
                [
                  "Wallet token balance",
                  "Public Solana account data",
                  "Public Solana account data",
                ],
                [
                  "Session grant public key and expiry",
                  "Public base-layer grant",
                  "Same; secret key stays in browser",
                ],
              ]}
            />
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <InfoCard
                eyebrow="Protected against"
                title="Unpermissioned observation"
              >
                Other traders, ordinary bots, public RPC clients and replica
                clients without membership should not be able to enumerate book
                owners or query private portfolios.
              </InfoCard>
              <InfoCard
                eyebrow="Not a claim against"
                title="Compromised client or failed TEE assumptions"
              >
                Browser malware can steal a session key, and privacy ultimately
                depends on the validator running the attested code inside the
                stated hardware boundary. Read the Proof panel instead of
                treating “private” as a slogan.
              </InfoCard>
            </div>
          </Section>

          <Section
            id="architecture"
            kicker="Protocol architecture"
            title="Custody on Solana, execution in the rollup"
            intro="The split limits what an execution-layer failure can do: trading state moves quickly in the PER, while token custody remains governed by base-layer instructions."
          >
            <div className="grid gap-4 md:grid-cols-[1fr_56px_1fr] md:items-stretch">
              <Layer title="Solana base layer" tone="base">
                <Chip>USDC custody vault</Chip>
                <Chip>Deposit ledger</Chip>
                <Chip>Market configuration</Chip>
                <Chip>Session grants</Chip>
                <Chip>Permission records</Chip>
                <Chip>Withdrawal receipts</Chip>
                <p className="mt-4 text-[11px] leading-5 text-dim">
                  Tokens move only here. Configuration is permanent and publicly
                  auditable.
                </p>
              </Layer>
              <div className="flex items-center justify-center text-center text-[10px] leading-5 text-dim md:flex-col">
                <span>delegate →</span>
                <span className="mx-3 md:mx-0">← commit</span>
              </div>
              <Layer title="Private ephemeral rollup" tone="rollup">
                <Chip hot>Dark order books</Chip>
                <Chip hot>Private portfolios</Chip>
                <Chip hot>Percolator risk group</Chip>
                <Chip hot>Oracle state</Chip>
                <Chip hot>TP/SL triggers</Chip>
                <Chip hot>Fill queues</Chip>
                <p className="mt-4 text-[11px] leading-5 text-dim">
                  Matching, risk checks, settlement, PnL and liquidation execute
                  here.
                </p>
              </Layer>
            </div>
            <div className="mt-5 rounded-xl border border-line-soft bg-ink p-5">
              <h3 className="text-[13px] font-semibold text-bright">
                The hub model
              </h3>
              <p className="mt-2 text-[12px] leading-6 text-muted">
                Markets 930–938 share one USDC vault, one Percolator risk group
                and one portfolio per trader. Each market still has its own
                book, oracle state, depth mirror and tape. The UI allocates
                collateral per asset for isolated liquidation while the
                account&apos;s free equity and admission certificate are
                evaluated at the shared portfolio level.
              </p>
            </div>
          </Section>

          <Section
            id="lifecycle"
            kicker="State machine"
            title="The complete life of a trade"
            intro="Matching and risk settlement are separate on a dark book because the taker is not allowed to discover the maker accounts it crossed."
          >
            <div className="relative ml-3 border-l border-line">
              <Flow title="Deposit" place="Solana">
                USDC enters the vault and the trader&apos;s monotonic ledger
                increases. No position exists yet.
              </Flow>
              <Flow title="Claim and delegate" place="Boundary">
                The portfolio is credited from the ledger, permission-protected
                and delegated into the PER.
              </Flow>
              <Flow title="Authorize" place="Solana → browser">
                The wallet grants a browser session key trading rights for up to
                seven days.
              </Flow>
              <Flow title="Place order" place="PER">
                The program authenticates the owner/session, checks the oracle
                band, refreshes account health, verifies free margin and
                reserves margin for any resting or pending quantity.
              </Flow>
              <Flow title="Match" place="PER book">
                The book walks strict price-time priority. The maker&apos;s
                resting price determines execution. Self-crosses remove the
                owner&apos;s resting order instead of producing a fake fill.
              </Flow>
              <Flow title="Queue" place="Dark boundary">
                The book records taker, maker, side, price and size in a private
                FIFO pending ring. The public still learns nothing.
              </Flow>
              <Flow title="Settle" place="PER risk">
                The keeper cranks the relevant market, refreshes both portfolios
                and asks Percolator to mint the long/short pair.
              </Flow>
              <Flow title="Print" place="Public tape">
                An accepted fill publishes only market, price, size, sequence
                and time. Refused fills are consumed without a tape print.
              </Flow>
              <Flow title="Mark, fund and liquidate" place="PER">
                Oracle cranks update risk state; portfolio refreshes realize
                losses and update PnL. Trigger and liquidation paths are
                permissionless but rule-bound.
              </Flow>
              <Flow title="Close and withdraw" place="PER → Solana">
                Reduce-only closing flattens exposure. The rollup authorizes a
                withdrawal receipt; only the base vault transfers tokens.
              </Flow>
            </div>
          </Section>

          <Section
            id="risk"
            kicker="Risk engine"
            title="What Percolator does—and what Anqa adds"
            intro="Percolator is the solvency authority embedded inside Anqa. The wrapper does not reimplement its margin arithmetic; it supplies the exchange mechanics and security boundaries around it."
          >
            <div className="grid gap-4 md:grid-cols-2">
              <InfoCard eyebrow="Percolator owns" title="Portfolio solvency">
                Position netting, equity, initial and maintenance requirements,
                PnL realization, funding accounting, loss/profit backing, health
                certificates, liquidation and bad-debt transitions.
              </InfoCard>
              <InfoCard eyebrow="Anqa owns" title="Exchange semantics">
                Custody, authentication, oracle acceptance, price ticks and
                lots, the CLOB, order-margin reservation, private matching,
                isolated collateral metadata, fill settlement and the public
                tape.
              </InfoCard>
            </div>
            <h3 className="mt-8 text-lg font-medium text-bright">
              How the ticket maps to risk
            </h3>
            <Formula
              label="Target notional"
              value="collateral × selected leverage"
            />
            <Formula
              label="Base size"
              value="target notional ÷ effective order price, rounded down to whole lots"
            />
            <Formula
              label="Free margin"
              value="certified equity − position requirement − reserved order margin"
            />
            <Formula
              label="Unrealized PnL"
              value="(mark − entry) × size for a long; reversed for a short"
            />
            <p className="mt-4 text-[12px] leading-6 text-muted">
              The venue&apos;s initial-margin requirement is 5% (20×). The UI
              can preview up to 25×, but an order above 20× needs enough
              additional free portfolio equity to satisfy the kernel. The
              on-chain check, not the slider, is final.
            </p>
            <h3 className="mt-8 text-lg font-medium text-bright">
              Isolated risk inside a shared account
            </h3>
            <p className="mt-3 text-[13px] leading-6 text-text">
              Your hub portfolio is shared across markets, but the amount
              entered as collateral is recorded against the selected asset. The
              isolated liquidator compares that position&apos;s own collateral,
              blended entry, PnL and maintenance requirement. When that asset is
              underwater, the protocol can close it without treating every other
              asset allocation as its liquidation budget.
            </p>
            <Callout title="Losses are senior; unproven wins are junior">
              Portfolio refreshes crystallize losses against real backing before
              profit becomes withdrawable capital. This prevents two accounts
              from both treating the same unsettled gain as senior collateral.
              The keeper expires stale backing buckets and realizes eligible
              PnL, but the kernel decides what is safe.
            </Callout>
          </Section>

          <Section
            id="oracles"
            kicker="Prices"
            title="Oracle policy, funding and circuit breakers"
            intro="A perp trade creates exposure at its execution price, so accepting arbitrary caller prices would create value from nothing. Anqa pins each market to a Pyth feed and bounds every fill around the accepted mark."
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Guard title="Pinned feed">
                A caller cannot substitute another asset&apos;s oracle account.
              </Guard>
              <Guard title="Maximum age">
                Stale prices halt risk transitions instead of silently becoming
                marks.
              </Guard>
              <Guard title="Confidence">
                A wide Pyth confidence interval is treated as an unreliable
                market.
              </Guard>
              <Guard title="Cross-source deviation">
                Large disagreement with the configured secondary source is
                rejected.
              </Guard>
              <Guard title="Move band">
                Sudden moves are bounded per crank and converge over repeated
                accepted steps.
              </Guard>
              <Guard title="Execution band">
                Orders and queued fills must remain within the market&apos;s
                allowed distance from mark.
              </Guard>
            </div>
            <DocTable
              heads={["Price", "Purpose", "Where you see it"]}
              rows={[
                [
                  "Index",
                  "External Pyth reference before protocol acceptance.",
                  "Chart / market data",
                ],
                [
                  "Mark",
                  "Accepted risk price for PnL, margin and liquidation.",
                  "Market bar and ticket",
                ],
                [
                  "Order limit",
                  "Worst price the trader authorizes.",
                  "Ticket and Resting Orders",
                ],
                [
                  "Fill / entry",
                  "Maker price at which settlement created exposure.",
                  "Tape and Positions",
                ],
              ]}
            />
            <p className="mt-5 text-[12px] leading-6 text-muted">
              Percolator supports funding accrual between long and short
              domains. The keeper advances the venue clock and funding state in
              bounded segments so an outage cannot skip an arbitrarily large
              accrual interval. The current devnet configuration may use a zero
              funding input while the mechanism is exercised and monitored.
            </p>
          </Section>

          <Section
            id="sessions"
            kicker="One-click trading"
            title="Session keys remove popups without moving custody authority"
            intro="The browser creates one keypair per wallet and stores it locally. The owner grants its public key a platform-wide trading session; the secret key never needs to leave that browser storage."
          >
            <DocTable
              heads={["Action", "Signer", "Wallet popup?"]}
              rows={[
                [
                  "Connect wallet",
                  "Wallet",
                  "Connection approval depends on wallet",
                ],
                ["Deposit / top up", "Wallet owner", "Yes"],
                [
                  "Grant or renew session",
                  "Wallet owner",
                  "Yes, once per grant",
                ],
                ["Place, cancel or modify order", "Session key", "No"],
                ["Close position", "Session key", "No"],
                ["Arm / cancel TP or SL", "Session key", "No"],
                ["Withdraw", "Wallet owner + protocol authorization", "Yes"],
                ["Revoke session", "Wallet owner", "Yes"],
              ]}
            />
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <InfoCard eyebrow="Scope" title="Trade-only authority">
                The on-chain instruction verifies that the supplied session
                belongs to the portfolio owner, matches the browser signer and
                has not expired. Custody instructions still require the wallet
                owner.
              </InfoCard>
              <InfoCard eyebrow="Security" title="Seven-day maximum">
                A grant expires after at most seven days and can be revoked
                without the session key. A compromised key can trade the account
                until expiry/revocation, so use a trusted browser profile and
                revoke unfamiliar sessions.
              </InfoCard>
            </div>
          </Section>

          <Section
            id="keepers"
            kicker="Automation"
            title="Keeper, maker and devnet auto-matcher"
            intro="These processes make the venue usable, but they have different roles. None should be confused with the risk authority."
          >
            <div className="space-y-3">
              <Role title="Keeper" badge="Liveness">
                Relays oracle data, advances the venue clock, cranks
                mark/funding, settles private FIFO fills, publishes depth and
                owner mirrors, credits deposits, refreshes PnL, scans
                liquidations, checkpoints safe state and restores demo quotes.
                Settlement is permissionless in rule: wrong accounts or prices
                fail.
              </Role>
              <Role title="Resident maker" badge="Counterparty">
                A funded devnet account posts shown bid/ask ladders around the
                mark. It takes the opposite side of real test positions and
                absorbs test PnL; it is liquidity, not an oracle or an admin
                override.
              </Role>
              <Role title="Delayed auto-matcher" badge="Devnet only">
                Watches the private queue as an authorized engine reader. After
                an unchanged user order has rested for at least ten seconds, it
                clears only its own quotes ahead of that order, submits an exact
                opposite IOC, restores its ladder and leaves canonical
                settlement to the keeper.
              </Role>
            </div>
            <Callout title="What happens if the keeper stops?" tone="warn">
              Orders can still be accepted or matched, but queued fills will not
              become positions, marks and health can become stale, deposits may
              wait for credit and liquidation/trigger work pauses. The program
              should refuse unsafe stale transitions rather than trade blind.
              Liveness degrades; the keeper does not gain permission to withdraw
              user funds.
            </Callout>
          </Section>

          <Section
            id="withdrawals"
            kicker="Custody"
            title="Close, flatten and withdraw"
            intro="A fill moves no tokens. Custody changes only on deposit and withdrawal, so withdrawing requires the protocol to prove that no live obligation is being abandoned."
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <Concept n="1" title="Cancel orders">
                Cancel every resting order. Their reserved margin is a live
                promise and cannot leave the account.
              </Concept>
              <Concept n="2" title="Close positions">
                Use Close in the Positions tab. The path is reduce-only and
                cannot accidentally flip you to the other side.
              </Concept>
              <Concept n="3" title="Withdraw">
                Open Deposit → Withdraw. The rollup authorizes against flat,
                refreshed equity; the base vault pays the owner&apos;s token
                account.
              </Concept>
            </div>
            <p className="mt-5 text-[12px] leading-6 text-muted">
              The withdrawal handshake separates authorization from token
              movement: a base receipt identifies the request, the rollup risk
              state approves an amount it can prove is free, and a base
              instruction transfers USDC. The rollup never owns the vault&apos;s
              token-signing authority.
            </p>
          </Section>

          <Section
            id="proof"
            kicker="Do not trust the copy"
            title="Verify the privacy and execution claims"
            intro="The terminal's Proof panel performs live checks instead of showing a static trust badge."
          >
            <div className="grid gap-4 md:grid-cols-2">
              <InfoCard
                eyebrow="Anonymous account probes"
                title="Same RPC, different answers"
              >
                The panel opens an unauthenticated connection. A healthy private
                book and delegated portfolio return null; the public tape
                returns bytes. Base-chain checks distinguish “permission
                refused” from “account absent.”
              </InfoCard>
              <InfoCard
                eyebrow="Remote attestation"
                title="Fresh challenge, fresh quote"
              >
                The browser generates a random challenge, requests an Intel TDX
                quote and checks that the response binds to that challenge.
                Certificate and revocation-chain verification runs server-side;
                the browser compares the binding itself.
              </InfoCard>
            </div>
            <Callout title="Measurement caveat" tone="neutral">
              Attestation can show that a real TDX environment produced the
              quote and report its measurement. A complete reproducible-build
              claim also needs a publicly pinned expected measurement. Until
              that reference exists, the UI displays the measurement rather than
              pretending it has judged the build.
            </Callout>
          </Section>

          <Section
            id="troubleshooting"
            kicker="Troubleshooting"
            title="When the UI does not show what you expected"
          >
            <DocTable
              heads={["Symptom", "Most likely meaning", "What to do"]}
              rows={[
                [
                  "Order is under Resting Orders",
                  "Your limit did not cross and is still live.",
                  "Wait for a counterparty / devnet matcher, amend it or cancel it.",
                ],
                [
                  "Order vanished but no position yet",
                  "It matched and is in the private pending queue, or settlement refused it.",
                  "Watch the Matching row and refresh; the portfolio is authoritative.",
                ],
                [
                  "Market order opens nothing",
                  "No opposing liquidity, stale risk/oracle state or settlement refusal.",
                  "Check the visible error, book side, rollup badge and keeper status.",
                ],
                [
                  "Wallet asks again",
                  "The session expired, changed browser storage or has not reached the rollup clone.",
                  "Approve one renewal; do not approve repeated unexplained prompts.",
                ],
                [
                  "Cannot withdraw",
                  "Open positions, resting orders, pending settlement or unrefreshed loss remains.",
                  "Cancel orders, close positions, wait for settlement and retry.",
                ],
                [
                  "Private account returns null",
                  "Expected for an unauthenticated reader.",
                  "Authenticate as the owner or inspect the Proof verdict.",
                ],
                [
                  "Hidden order absent from ladder",
                  "Expected: it is deliberately excluded from public depth.",
                  "Use your Resting Orders tab to confirm and cancel it.",
                ],
                [
                  "Limit price rejected",
                  "It lies outside the current oracle execution band.",
                  "Use the displayed band or wait for the mark to move.",
                ],
              ]}
            />
            <h3 className="mt-8 text-lg font-medium text-bright">
              Common questions
            </h3>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <MiniCard title="Can I reveal the book with my own Solana RPC?">
                No. A Solana RPC sees the last base-layer state, not the live
                delegated account. Rollup replicas use the authenticated primary
                ingress rather than receiving an unrestricted peer-gossip copy.
              </MiniCard>
              <MiniCard title="Can the matching environment read orders?">
                Yes—it must process plaintext to match them. The claim is that
                unauthorized readers and the host outside the attested TEE
                cannot inspect that state under the stated hardware and software
                assumptions.
              </MiniCard>
              <MiniCard title="Does Hidden improve queue position?">
                No. Hidden and shown orders use the same price, then arrival
                sequence. Hidden changes publication only.
              </MiniCard>
              <MiniCard title="Are my USDC tokens inside the rollup?">
                No. Tokens stay in the Solana custody vault. The rollup holds
                accounting state that authorizes what the base layer may later
                withdraw.
              </MiniCard>
              <MiniCard title="Why wait ten seconds on devnet?">
                It lets testers observe a real resting row before the test
                counterparty takes it. The delay belongs to the current demo
                auto-matcher, not the matching protocol.
              </MiniCard>
              <MiniCard title="Is this production or mainnet?">
                No. The current venue, collateral faucet, resident maker and
                auto-matcher are devnet infrastructure.
              </MiniCard>
            </div>
          </Section>

          <Section id="glossary" kicker="Reference" title="Glossary">
            <div className="divide-y divide-line-soft overflow-hidden rounded-xl border border-line-soft">
              {GLOSSARY.map(([term, definition]) => (
                <div
                  key={term}
                  className="grid gap-1 p-4 sm:grid-cols-[150px_1fr] sm:gap-5"
                >
                  <dt className="text-[12px] font-semibold text-bright">
                    {term}
                  </dt>
                  <dd className="text-[12px] leading-5 text-muted">
                    {definition}
                  </dd>
                </div>
              ))}
            </div>
          </Section>

          <footer className="mt-20 flex flex-col gap-4 border-t border-line-soft pt-8 text-[11px] text-dim sm:flex-row sm:items-center">
            <p>
              Anqa devnet documentation · Private execution, public evidence.
            </p>
            <div className="flex gap-4 sm:ml-auto">
              <Link href="/trade" className="text-muted hover:text-bright">
                Terminal
              </Link>
              <a
                href="https://github.com/anqa-labs/anqa-core"
                className="text-muted hover:text-bright"
              >
                Source ↗
              </a>
              <a href="#start" className="text-muted hover:text-bright">
                Back to top ↑
              </a>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}

function Section({
  id,
  kicker,
  title,
  intro,
  children,
}: {
  id: string;
  kicker: string;
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-24 border-b border-line-soft py-14 last:border-0"
    >
      <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-phoenix">
        {kicker}
      </span>
      <h2 className="mt-2 text-2xl font-medium tracking-[-0.025em] text-bright md:text-3xl">
        {title}
      </h2>
      {intro && (
        <p className="mt-3 max-w-[780px] text-[13px] leading-6 text-muted md:text-[14px]">
          {intro}
        </p>
      )}
      <div className="mt-7">{children}</div>
    </section>
  );
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "gold";
}) {
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.12em] ${
        tone === "gold"
          ? "border-phoenix/30 bg-phoenix/8 text-phoenix"
          : "border-line text-dim"
      }`}
    >
      {children}
    </span>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="bg-ink px-4 py-4">
      <div className="tnum text-lg font-medium text-bright">{value}</div>
      <div className="mt-0.5 text-[10px] text-dim">{label}</div>
    </div>
  );
}

function Strong({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-bright">{children}</strong>;
}

function Step({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-3 rounded-xl border border-line-soft bg-ink p-4 sm:grid-cols-[44px_1fr]">
      <span className="tnum flex h-8 w-8 items-center justify-center rounded-full border border-line text-[10px] text-phoenix">
        {n}
      </span>
      <div>
        <h3 className="text-[13px] font-semibold text-bright">{title}</h3>
        <p className="mt-1 text-[12px] leading-5 text-muted">{children}</p>
      </div>
    </div>
  );
}

function Callout({
  title,
  children,
  tone = "neutral",
}: {
  title: string;
  children: ReactNode;
  tone?: "neutral" | "warn";
}) {
  return (
    <div
      className={`my-7 rounded-xl border p-4 ${
        tone === "warn"
          ? "border-phoenix/25 bg-phoenix/[0.035]"
          : "border-line-soft bg-ink"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
            tone === "warn" ? "bg-phoenix" : "bg-muted"
          }`}
        />
        <div>
          <h3 className="text-[12px] font-semibold text-bright">{title}</h3>
          <p className="mt-1 text-[11px] leading-5 text-muted">{children}</p>
        </div>
      </div>
    </div>
  );
}

function DocTable({ heads, rows }: { heads: string[]; rows: string[][] }) {
  return (
    <div className="my-5 overflow-x-auto rounded-xl border border-line-soft">
      <table className="w-full min-w-[620px] border-collapse text-left">
        <thead className="bg-raised/50">
          <tr>
            {heads.map((head) => (
              <th
                key={head}
                className="border-b border-line-soft px-4 py-2.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-dim"
              >
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft bg-ink">
          {rows.map((row, i) => (
            <tr key={`${row[0]}-${i}`}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={`px-4 py-3 text-[11px] leading-5 ${
                    j === 0 ? "font-medium text-bright" : "text-muted"
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MiniCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-line-soft bg-ink p-4">
      <h3 className="text-[12px] font-semibold text-bright">{title}</h3>
      <p className="mt-2 text-[11px] leading-5 text-dim">{children}</p>
    </div>
  );
}

function InfoCard({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line-soft bg-ink p-5">
      <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-dim">
        {eyebrow}
      </span>
      <h3 className="mt-2 text-[14px] font-medium text-bright">{title}</h3>
      <p className="mt-2 text-[12px] leading-6 text-muted">{children}</p>
    </div>
  );
}

function Concept({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line-soft bg-ink p-4">
      <span className="tnum text-[10px] text-phoenix">{n}</span>
      <h3 className="mt-2 text-[13px] font-semibold text-bright">{title}</h3>
      <p className="mt-2 text-[11px] leading-5 text-muted">{children}</p>
    </div>
  );
}

function Layer({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "base" | "rollup";
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border bg-ink p-5 ${
        tone === "rollup" ? "border-phoenix/30" : "border-line-soft"
      }`}
    >
      <span
        className={`text-[9px] font-semibold uppercase tracking-[0.16em] ${
          tone === "rollup" ? "text-phoenix" : "text-dim"
        }`}
      >
        {title}
      </span>
      <div className="mt-4 flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Chip({
  children,
  hot = false,
}: {
  children: ReactNode;
  hot?: boolean;
}) {
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-[10px] ${
        hot ? "border-phoenix/25 text-phoenix" : "border-line text-muted"
      }`}
    >
      {children}
    </span>
  );
}

function Flow({
  title,
  place,
  children,
}: {
  title: string;
  place: string;
  children: ReactNode;
}) {
  return (
    <div className="relative py-4 pl-8">
      <span className="absolute -left-[5px] top-[23px] h-2.5 w-2.5 rounded-full border-2 border-void bg-phoenix" />
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-[13px] font-semibold text-bright">{title}</h3>
        <span className="rounded border border-line px-1.5 py-0.5 text-[8px] uppercase tracking-[0.12em] text-dim">
          {place}
        </span>
      </div>
      <p className="mt-1 text-[12px] leading-5 text-muted">{children}</p>
    </div>
  );
}

function Formula({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 border-b border-line-soft py-3 last:border-0 sm:grid-cols-[170px_1fr]">
      <span className="text-[11px] text-muted">{label}</span>
      <code className="font-mono text-[11px] text-phoenix">{value}</code>
    </div>
  );
}

function Guard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line-soft bg-ink p-4">
      <h3 className="text-[11px] font-semibold text-bright">{title}</h3>
      <p className="mt-1.5 text-[10px] leading-5 text-dim">{children}</p>
    </div>
  );
}

function Role({
  title,
  badge,
  children,
}: {
  title: string;
  badge: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line-soft bg-ink p-5">
      <div className="flex items-center gap-2">
        <h3 className="text-[14px] font-medium text-bright">{title}</h3>
        <span className="rounded-full border border-line px-2 py-0.5 text-[8px] uppercase tracking-[0.12em] text-dim">
          {badge}
        </span>
      </div>
      <p className="mt-2 text-[12px] leading-6 text-muted">{children}</p>
    </div>
  );
}
