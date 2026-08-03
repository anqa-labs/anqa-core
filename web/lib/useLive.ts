"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Tween a number toward its target so values glide instead of snapping.
 *
 * The polls arrive in steps — every second, every two — but a venue's
 * numbers should read as continuous. Ease-out by default; pass linear for
 * counters that should tick steadily (the rollup slot).
 */
export function useTweened(target: number | null, ms = 450, linear = false): number | null {
  const [shown, setShown] = useState<number | null>(target);
  const raf = useRef(0);
  const fromRef = useRef<number | null>(target);

  useEffect(() => {
    const from = fromRef.current;
    if (target === null || from === null) {
      fromRef.current = target;
      setShown(target);
      return;
    }
    if (target === from) return;
    const start = performance.now();
    const run = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const k = linear ? t : 1 - (1 - t) ** 3;
      const v = from + (target - from) * k;
      fromRef.current = v;
      setShown(v);
      if (t < 1) raf.current = requestAnimationFrame(run);
    };
    raf.current = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf.current);
  }, [target, ms, linear]);

  return shown;
}

/**
 * Which way a value last moved, plus a key that changes on every move —
 * key a flash class off it and the animation retriggers each tick.
 */
export function useTickFlash(value: number | null): {
  dir: "up" | "down" | null;
  key: number;
} {
  const prev = useRef<number | null>(null);
  const [state, setState] = useState<{ dir: "up" | "down" | null; key: number }>({
    dir: null,
    key: 0,
  });

  useEffect(() => {
    if (value === null) return;
    const before = prev.current;
    prev.current = value;
    if (before !== null && value !== before) {
      setState((s) => ({ dir: value > before ? "up" : "down", key: s.key + 1 }));
    }
  }, [value]);

  return state;
}
