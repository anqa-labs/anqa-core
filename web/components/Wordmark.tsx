/**
 * The mark: three feathers fanned from a single root — the old symmetric
 * burst made directional. It ships as its own badge (black plume on a white
 * chip) so it reads the same everywhere and is deliberately the one bright
 * thing in a graphite header.
 */
export function PhoenixMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" className={className} aria-hidden="true">
      <rect x="0.5" y="0.5" width="27" height="27" rx="6.5" fill="#ffffff" />
      <g fill="#0a0a0b" transform="translate(14 14) scale(0.78) translate(-12.2 -15.7)">
        <path d="M5 24.5 C12 22 17.5 17.5 20 11 C19 18.5 13 23.5 5 24.5 Z" />
        <path
          d="M5 24.5 C12 22 17.5 17.5 20 11 C19 18.5 13 23.5 5 24.5 Z"
          transform="rotate(-16 5 24.5)"
        />
        <path
          d="M5 24.5 C12 22 17.5 17.5 20 11 C19 18.5 13 23.5 5 24.5 Z"
          transform="rotate(-33 5 24.5)"
        />
      </g>
    </svg>
  );
}

export function Wordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <PhoenixMark className="w-5 h-5" />
      <span className="text-[19px] font-medium tracking-[0.14em] text-bright lowercase">
        anqa
      </span>
    </div>
  );
}
