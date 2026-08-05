/**
 * Say what actually went wrong.
 *
 * Anchor errors coming back from the MagicBlock rollup arrive as objects with
 * `{ code, msg, logs }` and an **empty-string `.message`**. The idiom this
 * codebase reached for everywhere — `String(e?.message ?? e)` — therefore
 * prints nothing at all, because `??` only falls back on null/undefined and
 * `""` is neither. A whole outage hid behind that: `place_order` was returning
 * "post-only order would have crossed the book" and every log line said "".
 *
 * Ingress rejections arrive the other way round (a real `.message`, no `.msg`,
 * no logs), so both shapes have to be handled or the fix just moves the blind
 * spot. Program logs are appended when present, since the kernel reports its
 * refusals through `msg!` rather than through the error.
 */

export function errText(e: any, limit = 160): string {
  const parts: string[] = [];
  const primary = e?.msg ?? (e?.message || null) ?? (e ? String(e) : "unknown error");
  parts.push(String(primary));
  if (e?.code !== undefined && e?.code !== null) parts.push(`(code ${e.code})`);
  const anchor = e?.error?.errorMessage ?? e?.errorMessage;
  if (anchor && !parts[0].includes(String(anchor))) parts.push(`— ${anchor}`);
  const out = parts.join(" ");
  return out.length > limit ? out.slice(0, limit) + "…" : out;
}

/** The program's own account of the failure — `msg!` lines, not the error. */
export function errLogs(e: any, max = 6): string {
  const logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
  const interesting = logs.filter(
    (l) => l.includes("anqa:") || l.includes("Error Message") || l.includes("AnchorError")
  );
  const chosen = (interesting.length ? interesting : logs).slice(0, max);
  return chosen.length ? "\n      " + chosen.join("\n      ") : "";
}

/** One line, with the program's reasoning when it offered any. */
export function explain(e: any, limit = 160): string {
  return errText(e, limit) + errLogs(e);
}
