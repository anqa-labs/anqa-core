/**
 * The mark: a bird reduced to the one thing you can still recognise it by —
 * the spread of a wing. Everything else is left out, which is the joke the
 * whole venue is built on.
 */
export function PhoenixMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
      <path
        d="M14 3.5c1.9 3.2 4.6 5.2 8.2 6.1-2.5.9-4.3 2.2-5.6 3.9 2.4-.5 4.6-.2 6.6.9-3.1.6-5.5 2-7.2 4.2 1.9-.3 3.6 0 5.1.9-3.9.6-6.4 2.6-7.1 5.6-.7-3-3.2-5-7.1-5.6 1.5-.9 3.2-1.2 5.1-.9-1.7-2.2-4.1-3.6-7.2-4.2 2-1.1 4.2-1.4 6.6-.9-1.3-1.7-3.1-3-5.6-3.9 3.6-.9 6.3-2.9 8.2-6.1z"
        fill="currentColor"
      />
    </svg>
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <PhoenixMark className="w-5 h-5 text-phoenix" />
      <div className="flex items-baseline gap-2">
        <span className="text-[19px] font-medium tracking-[0.14em] text-bright lowercase">
          anqa
        </span>
        {!compact && (
          <span
            className="text-[15px] text-phoenix-soft/80 translate-y-[1px]"
            lang="ar"
            dir="rtl"
          >
            عنقاء
          </span>
        )}
      </div>
    </div>
  );
}
