"use client";

import { type ReactNode } from "react";

/** A titled surface. Every region of the terminal is one of these. */
export function Panel({
  title,
  right,
  children,
  className = "",
  bodyClassName = "",
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={`flex flex-col min-h-0 bg-ink border border-line-soft rounded-lg overflow-hidden ${className}`}
    >
      {title && (
        <header className="flex items-center justify-between shrink-0 px-3 h-9 border-b border-line-soft">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.13em] text-dim">
            {title}
          </h2>
          {right}
        </header>
      )}
      <div className={`flex-1 min-h-0 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "bid" | "ask" | "phoenix";
}) {
  const tones = {
    default: "text-bright",
    bid: "text-bid",
    ask: "text-ask",
    phoenix: "text-phoenix",
  };
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-[0.12em] text-dim">{label}</span>
      <span className={`tnum text-[15px] font-medium ${tones[tone]}`}>{value}</span>
      {hint && <span className="text-[10px] text-dim">{hint}</span>}
    </div>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "default",
  size = "md",
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "default" | "primary" | "bid" | "ask" | "ghost";
  size?: "sm" | "md";
  className?: string;
  type?: "button" | "submit";
}) {
  const variants = {
    default:
      "bg-raised border border-line text-text hover:border-phoenix-soft disabled:hover:border-line",
    primary:
      "bg-phoenix/12 border border-phoenix/45 text-ember hover:bg-phoenix/20 disabled:hover:bg-phoenix/12",
    bid: "bg-bid/12 border border-bid/40 text-bid hover:bg-bid/20 disabled:hover:bg-bid/12",
    ask: "bg-ask/12 border border-ask/40 text-ask hover:bg-ask/20 disabled:hover:bg-ask/12",
    ghost: "border border-transparent text-dim hover:text-text hover:border-line",
  };
  const sizes = {
    sm: "h-7 px-2.5 text-[11px] rounded",
    md: "h-9 px-3.5 text-[13px] rounded-md",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  suffix,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  suffix?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-[0.12em] text-dim">{label}</span>
      <div className="relative">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          inputMode="decimal"
          className="tnum w-full h-9 bg-void border border-line rounded-md px-2.5 pr-12 text-[13px] text-bright
                     outline-none transition-colors focus:border-phoenix-soft disabled:opacity-40
                     placeholder:text-dim/60"
        />
        {suffix && (
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-dim pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
    </label>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "dark" | "live" | "warn";
}) {
  const tones = {
    neutral: "border-line text-muted",
    dark: "border-phoenix/40 text-phoenix bg-phoenix/8",
    live: "border-bid/40 text-bid bg-bid/8",
    warn: "border-ask/40 text-ask bg-ask/8",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 h-5 px-2 rounded border text-[10px] font-medium uppercase tracking-[0.1em] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-16 grid place-items-center px-4 py-6 text-center">
      <p className="text-[12px] text-dim leading-relaxed max-w-[26ch]">{children}</p>
    </div>
  );
}
