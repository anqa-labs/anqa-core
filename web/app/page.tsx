import type { Metadata } from "next";
import Link from "next/link";
import { LandingMotion } from "@/components/LandingMotion";
import { PhoenixMark, Wordmark } from "@/components/Wordmark";

export const metadata: Metadata = {
  title: "Anqa — private perpetual markets on Solana",
  description:
    "A privacy-preserving perpetual futures exchange powered by MagicBlock Private Ephemeral Rollups. Hidden orders, private positions and one-click trading on Solana.",
};

const FEATURES = [
  {
    index: "01",
    eyebrow: "Dark CLOB",
    title: "A real order book without order-flow leakage.",
    body: "Strict price-time priority and familiar market structure, while the full book and order owners remain inside the private execution boundary.",
  },
  {
    index: "02",
    eyebrow: "Hidden orders",
    title: "Rest publicly nowhere. Match normally.",
    body: "A hidden order is excluded from the aggregate ladder entirely, yet keeps the same matching rules and queue priority as every other order.",
  },
  {
    index: "03",
    eyebrow: "Session execution",
    title: "One approval. Then trade at market speed.",
    body: "A scoped, expiring session key can place and cancel orders without repeated wallet popups. Custody permissions never leave the wallet.",
  },
  {
    index: "04",
    eyebrow: "Percolator risk",
    title: "Margin is enforced where matching happens.",
    body: "Position admission, isolated collateral, PnL, funding and liquidation are evaluated beside the book inside the rollup.",
  },
  {
    index: "05",
    eyebrow: "Public evidence",
    title: "Private state. Observable market.",
    body: "Aggregate shown depth and every settled fill remain public, providing price discovery without exposing counterparties or private positions.",
  },
  {
    index: "06",
    eyebrow: "Solana custody",
    title: "Execution moves. Collateral does not.",
    body: "USDC stays in a program-controlled Solana vault. The private rollup carries trading and risk state, not the vault’s token authority.",
  },
] as const;

const ASKS = [
  ["64,854.00", "0.820", "2.480", "56%"],
  ["64,849.00", "0.430", "1.660", "34%"],
  ["64,844.00", "0.690", "1.230", "46%"],
] as const;

const BIDS = [
  ["64,835.00", "0.540", "0.540", "38%"],
  ["64,829.00", "0.710", "1.250", "49%"],
  ["64,823.00", "0.390", "1.640", "29%"],
] as const;

export default function LandingPage() {
  return (
    <div className="min-h-dvh overflow-hidden bg-void text-text selection:bg-phoenix/20 selection:text-bright">
      <LandingMotion />
      <LandingNav />

      <main>
        <section data-hero className="landing-grid relative isolate border-b border-line-soft">
          <div data-pointer-glow className="landing-pointer-glow" aria-hidden="true" />
          <div className="landing-orbit landing-orbit-one" aria-hidden="true" />
          <div className="landing-orbit landing-orbit-two" aria-hidden="true" />
          <div className="landing-glow pointer-events-none absolute left-1/2 top-[-360px] -z-10 h-[760px] w-[980px] -translate-x-1/2 rounded-full" />
          <div className="mx-auto grid min-h-[760px] max-w-[1440px] items-center gap-16 px-5 pb-24 pt-24 md:px-8 lg:grid-cols-[0.92fr_1.08fr] lg:px-12 lg:pb-28 lg:pt-28">
            <div className="relative z-10 max-w-[680px]">
              <div className="landing-reveal flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-phoenix">
                <span className="live-dot h-1.5 w-1.5 rounded-full bg-bid" />
                Live on Solana devnet
              </div>
              <h1 className="landing-reveal landing-delay-1 mt-7 text-[52px] font-medium leading-[0.98] tracking-[-0.055em] text-bright sm:text-[68px] lg:text-[76px]">
                Trade without
                <br />
                broadcasting
                <span className="text-phoenix"> your edge.</span>
              </h1>
              <p className="landing-reveal landing-delay-2 mt-7 max-w-[590px] text-[16px] leading-7 text-muted md:text-[18px] md:leading-8">
                Anqa is a privacy-preserving perpetual futures exchange with a
                dark central limit order book, hidden positions and instant
                session-key execution—powered by MagicBlock&apos;s Private
                Ephemeral Rollups.
              </p>
              <div className="landing-reveal landing-delay-3 mt-9 flex flex-wrap items-center gap-3">
                <Link
                  href="/trade"
                  className="group flex h-12 items-center gap-3 rounded-lg bg-phoenix px-5 text-[13px] font-semibold text-void transition-[filter,transform] hover:-translate-y-0.5 hover:brightness-110"
                >
                  Launch terminal
                  <span className="transition-transform group-hover:translate-x-1">→</span>
                </Link>
                <Link
                  href="/docs"
                  className="flex h-12 items-center rounded-lg border border-line bg-ink/70 px-5 text-[13px] font-medium text-text backdrop-blur-sm transition-colors hover:border-phoenix-soft hover:text-bright"
                >
                  Read the protocol
                </Link>
              </div>
              <div className="landing-reveal landing-delay-4 mt-11 flex flex-wrap gap-x-8 gap-y-4 border-t border-line-soft pt-6 text-[11px] text-dim">
                <ProofPoint>Private book + portfolios</ProofPoint>
                <ProofPoint>Public fills + aggregate depth</ProofPoint>
                <ProofPoint>Open-source program</ProofPoint>
              </div>
            </div>

            <div data-parallax="0.045" className="landing-parallax landing-reveal landing-delay-2 relative mx-auto w-full max-w-[680px] lg:mx-0">
              <div data-tilt className="landing-tilt">
                <MarketVisual />
              </div>
            </div>
          </div>
        </section>

        <ProofStrip />

        <section id="privacy" className="border-b border-line-soft">
          <div className="mx-auto max-w-[1280px] px-5 py-24 md:px-8 md:py-32">
            <div className="grid gap-12 lg:grid-cols-[0.78fr_1.22fr] lg:gap-24">
              <div data-reveal>
                <SectionLabel>Privacy model</SectionLabel>
                <h2 className="mt-5 max-w-[510px] text-4xl font-medium leading-[1.05] tracking-[-0.04em] text-bright md:text-5xl">
                  The market is visible.
                  <br />
                  Your strategy is not.
                </h2>
                <p className="mt-6 max-w-[500px] text-[14px] leading-7 text-muted">
                  Anqa publishes enough for a functioning market without
                  publishing the information that makes a trader a target.
                </p>
              </div>

              <div data-reveal className="grid gap-px overflow-hidden rounded-2xl border border-line-soft bg-line-soft md:grid-cols-3">
                <PrivacyColumn label="Private" tone="private">
                  <PrivacyItem>Full order book</PrivacyItem>
                  <PrivacyItem>Order ownership</PrivacyItem>
                  <PrivacyItem>Positions and entry</PrivacyItem>
                  <PrivacyItem>Margin and liquidation</PrivacyItem>
                </PrivacyColumn>
                <PrivacyColumn label="Public" tone="public">
                  <PrivacyItem>Shown aggregate depth</PrivacyItem>
                  <PrivacyItem>Fill price and size</PrivacyItem>
                  <PrivacyItem>Market configuration</PrivacyItem>
                  <PrivacyItem>Custody balances</PrivacyItem>
                </PrivacyColumn>
                <PrivacyColumn label="The honest boundary" tone="boundary">
                  <p className="text-[12px] leading-6 text-muted">
                    Orders are plaintext to the matching program inside the
                    TEE. Confidentiality comes from permissioned access and
                    attested execution—not encrypted matching or zero-knowledge
                    proofs.
                  </p>
                </PrivacyColumn>
              </div>
            </div>
          </div>
        </section>

        <section id="architecture" className="relative border-b border-line-soft bg-ink/35">
          <div className="mx-auto max-w-[1280px] px-5 py-24 md:px-8 md:py-32">
            <div data-reveal className="mx-auto max-w-[760px] text-center">
              <SectionLabel>Protocol architecture</SectionLabel>
              <h2 className="mt-5 text-4xl font-medium leading-[1.05] tracking-[-0.04em] text-bright md:text-5xl">
                Custody on Solana.
                <br />
                Execution at rollup speed.
              </h2>
              <p className="mx-auto mt-6 max-w-[620px] text-[14px] leading-7 text-muted">
                Each responsibility lives where its guarantees are strongest.
                Traders keep a familiar workflow while the protocol separates
                authorization, private execution and token movement.
              </p>
            </div>

            <div className="reveal-grid mt-16 grid gap-3 lg:grid-cols-3">
              <div data-reveal>
                <ArchitectureCard
                  number="01"
                  eyebrow="Trader"
                  title="Browser session"
                  body="The wallet authorizes a scoped, expiring trading key. Orders become instant; deposits and withdrawals still require custody authority."
                  tags={["Session key", "Owner view", "1-click"]}
                />
              </div>
              <div data-reveal>
                <ArchitectureCard
                  number="02"
                  eyebrow="MagicBlock PER"
                  title="Private execution"
                  body="The dark CLOB, portfolios, Percolator risk state, oracle acceptance and matching execute together inside the TEE-backed rollup."
                  tags={["Matching", "Risk", "Liquidation"]}
                  featured
                />
              </div>
              <div data-reveal>
                <ArchitectureCard
                  number="03"
                  eyebrow="Solana"
                  title="Public custody"
                  body="USDC vaults, permanent configuration, permission records and withdrawal settlement remain on the base layer and publicly auditable."
                  tags={["USDC vault", "Permissions", "Receipts"]}
                />
              </div>
            </div>
          </div>
        </section>

        <section id="features" className="border-b border-line-soft">
          <div className="mx-auto max-w-[1280px] px-5 py-24 md:px-8 md:py-32">
            <div data-reveal className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
              <div>
                <SectionLabel>Built as a venue</SectionLabel>
                <h2 className="mt-5 max-w-[680px] text-4xl font-medium leading-[1.05] tracking-[-0.04em] text-bright md:text-5xl">
                  Privacy is part of the market structure—not a cosmetic mode.
                </h2>
              </div>
              <Link
                href="/docs"
                className="w-fit text-[12px] font-medium text-phoenix hover:text-ember"
              >
                Explore the complete design →
              </Link>
            </div>

            <div className="reveal-grid mt-14 grid gap-px overflow-hidden rounded-2xl border border-line-soft bg-line-soft md:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature) => (
                <article data-reveal key={feature.index} className="landing-feature-card group bg-ink p-7 transition-colors hover:bg-surface md:p-8">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-phoenix">
                      {feature.eyebrow}
                    </span>
                    <span className="tnum text-[10px] text-dim">{feature.index}</span>
                  </div>
                  <h3 className="mt-9 max-w-[330px] text-[20px] font-medium leading-7 tracking-[-0.02em] text-bright">
                    {feature.title}
                  </h3>
                  <p className="mt-4 max-w-[360px] text-[12px] leading-6 text-muted">
                    {feature.body}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="relative overflow-hidden">
          <div className="landing-grid absolute inset-0 opacity-45" aria-hidden="true" />
          <div className="landing-glow pointer-events-none absolute left-1/2 top-[-500px] h-[760px] w-[960px] -translate-x-1/2 rounded-full opacity-70" />
          <div data-reveal className="relative mx-auto flex max-w-[980px] flex-col items-center px-5 py-28 text-center md:py-40">
            <PhoenixMark className="h-9 w-9 text-phoenix" />
            <p className="mt-6 text-[10px] font-semibold uppercase tracking-[0.2em] text-phoenix">
              Known by name, unseen by eye
            </p>
            <h2 className="mt-5 text-4xl font-medium leading-[1.03] tracking-[-0.045em] text-bright md:text-6xl">
              Enter the private market.
            </h2>
            <p className="mt-6 max-w-[560px] text-[14px] leading-7 text-muted">
              Nine perpetual markets are live on devnet. Connect once, create a
              trading session and experience the complete order lifecycle.
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-3">
              <Link
                href="/trade"
                className="group flex h-12 items-center gap-3 rounded-lg bg-phoenix px-6 text-[13px] font-semibold text-void transition-[filter,transform] hover:-translate-y-0.5 hover:brightness-110"
              >
                Launch Anqa <span className="transition-transform group-hover:translate-x-1">→</span>
              </Link>
              <a
                href="https://github.com/anqa-labs/anqa-core"
                target="_blank"
                rel="noreferrer"
                className="flex h-12 items-center rounded-lg border border-line bg-ink/80 px-6 text-[13px] text-text transition-colors hover:border-phoenix-soft hover:text-bright"
              >
                View source ↗
              </a>
            </div>
          </div>
        </section>
      </main>

      <LandingFooter />
    </div>
  );
}

function LandingNav() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-line-soft/80 bg-void/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center px-5 md:px-8 lg:px-12">
        <Link href="/" aria-label="Anqa home">
          <Wordmark />
        </Link>
        <nav className="ml-auto hidden items-center gap-1 md:flex">
          <a href="#privacy" className="rounded-md px-3 py-2 text-[11px] text-muted hover:text-bright">
            Privacy
          </a>
          <a href="#architecture" className="rounded-md px-3 py-2 text-[11px] text-muted hover:text-bright">
            Architecture
          </a>
          <Link href="/docs" className="rounded-md px-3 py-2 text-[11px] text-muted hover:text-bright">
            Docs
          </Link>
          <a
            href="https://github.com/anqa-labs/anqa-core"
            target="_blank"
            rel="noreferrer"
            className="rounded-md px-3 py-2 text-[11px] text-muted hover:text-bright"
          >
            GitHub ↗
          </a>
        </nav>
        <Link
          href="/trade"
          className="ml-5 flex h-9 items-center rounded-lg border border-phoenix/40 px-3.5 text-[11px] font-semibold text-phoenix transition-colors hover:bg-phoenix/10 md:ml-6"
        >
          Launch terminal
        </Link>
      </div>
    </header>
  );
}

function MarketVisual() {
  return (
    <div className="landing-terminal relative rounded-2xl border border-line bg-ink/95 p-2 shadow-2xl shadow-black/60">
      <div className="flex h-10 items-center border-b border-line-soft px-3">
        <div className="flex gap-1.5" aria-hidden="true">
          <span className="h-2 w-2 rounded-full bg-ask/70" />
          <span className="h-2 w-2 rounded-full bg-phoenix/70" />
          <span className="h-2 w-2 rounded-full bg-bid/70" />
        </div>
        <span className="ml-4 text-[10px] font-medium text-muted">BTC-PERP / dark book</span>
        <span className="ml-auto flex items-center gap-1.5 text-[9px] uppercase tracking-[0.12em] text-bid">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-bid" /> PER live
        </span>
      </div>

      <div className="grid gap-2 p-2 sm:grid-cols-[1.15fr_0.85fr]">
        <div className="overflow-hidden rounded-xl border border-line-soft bg-void/60">
          <div className="flex h-10 items-center border-b border-line-soft px-3">
            <span className="text-[11px] font-medium text-bright">Aggregate depth</span>
            <span className="ml-auto text-[9px] uppercase tracking-[0.12em] text-dim">owners withheld</span>
          </div>
          <div className="grid grid-cols-3 border-b border-line-soft px-3 py-2 text-[8px] uppercase tracking-[0.12em] text-dim">
            <span>Price</span><span className="text-right">Size</span><span className="text-right">Total</span>
          </div>
          <div className="flex flex-col-reverse py-1">
            {ASKS.map((row, index) => <VisualBookRow key={row[0]} row={row} side="ask" delay={index} />)}
          </div>
          <div className="grid grid-cols-3 items-center border-y border-line-soft bg-surface/70 px-3 py-2 text-[10px]">
            <span className="tnum text-text">1.00</span>
            <span className="text-center text-muted">Spread</span>
            <span className="tnum text-right text-text">0.014%</span>
          </div>
          <div className="py-1">
            {BIDS.map((row, index) => <VisualBookRow key={row[0]} row={row} side="bid" delay={index} />)}
          </div>
          <div className="border-t border-line-soft px-3 py-2 text-[9px] text-dim">
            Public sizes are totals. Never whose.
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="landing-private-card relative overflow-hidden rounded-xl border border-phoenix-soft bg-surface p-4">
            <div className="absolute inset-0 veil opacity-20" aria-hidden="true" />
            <div className="relative flex items-center justify-between">
              <span className="text-[9px] font-semibold uppercase tracking-[0.15em] text-phoenix">Your hidden order</span>
              <span className="rounded border border-phoenix-soft px-1.5 py-0.5 text-[8px] text-phoenix">TEE only</span>
            </div>
            <div className="relative mt-5 flex items-end justify-between">
              <div>
                <p className="text-[9px] uppercase tracking-[0.12em] text-dim">Buy BTC</p>
                <p className="tnum mt-1 text-[20px] font-medium text-bright">0.154</p>
              </div>
              <div className="text-right">
                <p className="text-[9px] uppercase tracking-[0.12em] text-dim">Limit</p>
                <p className="tnum mt-1 text-[13px] text-bid">$64,580</p>
              </div>
            </div>
            <div className="relative mt-5 flex items-center gap-2 border-t border-line-soft pt-3 text-[9px] text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-phoenix" />
              Resting with full priority · off ladder
            </div>
          </div>

          <div className="rounded-xl border border-line-soft bg-void/60 p-4">
            <div className="flex items-center justify-between">
              <span className="text-[9px] font-semibold uppercase tracking-[0.15em] text-dim">Private position</span>
              <span className="rounded bg-bid/10 px-1.5 py-0.5 text-[8px] font-semibold text-bid">LONG</span>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-4">
              <VisualMetric label="Size" value="0.154 BTC" />
              <VisualMetric label="Entry" value="$64,580" />
              <VisualMetric label="Margin" value="$1,000" />
              <VisualMetric label="PnL" value="+$18.42" tone="bid" />
            </div>
          </div>

          <div className="flex items-center gap-2 rounded-xl border border-line-soft bg-void/50 px-3 py-3 text-[9px] text-muted">
            <span className="grid h-6 w-6 place-items-center rounded-full border border-line text-phoenix">✓</span>
            <span>Session signed</span>
            <span className="ml-auto text-bid">No wallet popup</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function VisualBookRow({ row, side, delay }: { row: readonly string[]; side: "bid" | "ask"; delay: number }) {
  return (
    <div className="relative grid grid-cols-3 px-3 py-1.5 text-[10px]">
      <span
        className={`landing-book-bar absolute inset-y-0 right-0 ${side === "bid" ? "bg-bid/10" : "bg-ask/10"}`}
        style={{ width: row[3], animationDelay: `${400 + delay * 100}ms` }}
      />
      <span className={`relative tnum ${side === "bid" ? "text-bid" : "text-ask"}`}>{row[0]}</span>
      <span className="relative tnum text-right text-text">{row[1]}</span>
      <span className="relative tnum text-right text-muted">{row[2]}</span>
    </div>
  );
}

function VisualMetric({ label, value, tone }: { label: string; value: string; tone?: "bid" }) {
  return (
    <div>
      <p className="text-[8px] uppercase tracking-[0.12em] text-dim">{label}</p>
      <p className={`tnum mt-1 text-[11px] ${tone === "bid" ? "text-bid" : "text-text"}`}>{value}</p>
    </div>
  );
}

function ProofStrip() {
  return (
    <section className="border-b border-line-soft bg-ink/45">
      <div className="reveal-grid mx-auto grid max-w-[1280px] grid-cols-2 gap-px px-5 md:grid-cols-4 md:px-8">
        <MiniProof value="9" label="live perp markets" />
        <MiniProof value="PER" label="private execution" />
        <MiniProof value="1-click" label="session trading" />
        <MiniProof value="100%" label="open source" />
      </div>
    </section>
  );
}

function MiniProof({ value, label }: { value: string; label: string }) {
  return (
    <div data-reveal className="border-x border-line-soft px-4 py-6 text-center">
      <p className="tnum text-[18px] font-medium text-bright">{value}</p>
      <p className="mt-1 text-[9px] uppercase tracking-[0.12em] text-dim">{label}</p>
    </div>
  );
}

function ProofPoint({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className="h-1 w-1 rounded-full bg-phoenix" /> {children}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] font-semibold uppercase tracking-[0.19em] text-phoenix">{children}</p>;
}

function PrivacyColumn({ label, tone, children }: { label: string; tone: "private" | "public" | "boundary"; children: React.ReactNode }) {
  return (
    <div className="relative min-h-[330px] bg-ink p-6 md:p-7">
      {tone === "private" && <div className="absolute inset-0 veil opacity-[0.08]" aria-hidden="true" />}
      <div className="relative">
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${tone === "private" ? "bg-phoenix" : tone === "public" ? "bg-bid" : "bg-dim"}`} />
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.15em] text-bright">{label}</h3>
        </div>
        <div className="mt-8 space-y-4">{children}</div>
      </div>
    </div>
  );
}

function PrivacyItem({ children }: { children: React.ReactNode }) {
  return <p className="border-b border-line-soft pb-3 text-[12px] text-muted">{children}</p>;
}

function ArchitectureCard({ number, eyebrow, title, body, tags, featured = false }: { number: string; eyebrow: string; title: string; body: string; tags: readonly string[]; featured?: boolean }) {
  return (
    <article className={`landing-architecture-card relative h-full overflow-hidden rounded-2xl border p-7 md:p-8 ${featured ? "border-phoenix-soft bg-surface" : "border-line-soft bg-ink"}`}>
      {featured && <div className="landing-card-glow absolute -right-24 -top-24 h-52 w-52 rounded-full" />}
      <div className="relative flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-phoenix">{eyebrow}</span>
        <span className="tnum text-[10px] text-dim">{number}</span>
      </div>
      <h3 className="relative mt-12 text-2xl font-medium tracking-[-0.03em] text-bright">{title}</h3>
      <p className="relative mt-4 min-h-[96px] text-[12px] leading-6 text-muted">{body}</p>
      <div className="relative mt-8 flex flex-wrap gap-2 border-t border-line-soft pt-5">
        {tags.map((tag) => <span key={tag} className="rounded-full border border-line px-2.5 py-1 text-[9px] text-dim">{tag}</span>)}
      </div>
    </article>
  );
}

function LandingFooter() {
  return (
    <footer className="border-t border-line-soft bg-ink">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-6 px-5 py-8 text-[10px] text-dim sm:flex-row sm:items-center md:px-8">
        <Link href="/" aria-label="Anqa home"><Wordmark compact /></Link>
        <p>Private execution. Public evidence. Solana devnet.</p>
        <div className="flex gap-5 sm:ml-auto">
          <Link href="/trade" className="hover:text-bright">Terminal</Link>
          <Link href="/docs" className="hover:text-bright">Docs</Link>
          <a href="https://github.com/anqa-labs/anqa-core" target="_blank" rel="noreferrer" className="hover:text-bright">GitHub ↗</a>
        </div>
      </div>
    </footer>
  );
}
