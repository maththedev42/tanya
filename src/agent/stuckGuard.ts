import { createHash } from "node:crypto";

// Unified StuckGuard (R3b, CodeWhale port): step fingerprints over FAILED
// tool calls — {tool, canonical-args-hash, error-signature} — with
// warn-then-stop escalation. Complements (does not replace) the narrower
// detectors (shell spiral, labelled repeated-failure guard, read dedup):
// those key on the command TEXT, which a model side-steps by re-spelling the
// command. Folding the ERROR SIGNATURE in is what catches "same failure,
// cosmetically different command" (the `… | cat -A` class), and the
// alternation window catches A/B/A/B two-step loops.
//
// Escalation contract (dodGate-safe — this guard NEVER fails a run):
//   warn: inject a one-time advisory nudge naming the repeated failure.
//   stop: the caller opens the beta.32 wrap-up window (commit + report),
//         the same graceful stop every other stall uses.
// Any successful file mutation resets all streaks — real progress unsticks.

export const STUCK_WARN_AFTER = 3;
export const STUCK_STOP_AFTER = 5;
// The coarse error-only fold is one step laxer: different tools/args, same
// normalized error. Threshold slightly higher because it is coarser.
export const STUCK_ERROR_FOLD_WARN_AFTER = 4;
export const STUCK_ERROR_FOLD_STOP_AFTER = 6;
const ALTERNATION_WINDOW = 6;

export type StuckAction = "none" | "warn" | "stop";

function hash16(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function canonicalArgsHash(input: unknown): string {
  return hash16(stableStringify(input));
}

/** Normalize an error text into a stable signature: numbers, hex ids, and
 *  absolute paths collapse so retry counters, timestamps, and tmp paths do
 *  not make the "same" failure look fresh. */
export function errorSignature(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/\/[^\s"']+/g, "<path>")
    .replace(/0x[0-9a-f]+/g, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000);
  return hash16(normalized);
}

export interface StuckObservation {
  action: StuckAction;
  /** Human-readable reason for the advisory/stop; set when action != none. */
  reason?: string;
  /** True when this exact observation already warned once (dedupe nudges). */
  repeatedWarn?: boolean;
}

export class StuckGuard {
  private exactStreaks = new Map<string, number>();
  private errorStreaks = new Map<string, number>();
  private recentKeys: string[] = [];
  private warned = new Set<string>();

  /** Call on every REAL failed tool execution (skips/synthetic results are
   *  not executions). Returns the escalation action for this step. */
  observeFailure(tool: string, input: unknown, errorText: string): StuckObservation {
    const argsKey = `${tool}::${canonicalArgsHash(input)}`;
    const errKey = errorSignature(errorText);
    const exactKey = `${argsKey}::${errKey}`;

    const exactCount = (this.exactStreaks.get(exactKey) ?? 0) + 1;
    this.exactStreaks.set(exactKey, exactCount);
    const errorCount = (this.errorStreaks.get(errKey) ?? 0) + 1;
    this.errorStreaks.set(errKey, errorCount);

    this.recentKeys.push(exactKey);
    if (this.recentKeys.length > ALTERNATION_WINDOW) this.recentKeys.shift();

    // A/B alternation: the last 6 failures alternate between exactly two
    // fingerprints — a two-step loop neither per-key streak sees as hot.
    const alternating = this.recentKeys.length === ALTERNATION_WINDOW
      && new Set(this.recentKeys).size === 2
      && this.recentKeys.every((key, index) => index < 2 || key === this.recentKeys[index - 2]);

    if (exactCount >= STUCK_STOP_AFTER || errorCount >= STUCK_ERROR_FOLD_STOP_AFTER || alternating) {
      const reason = alternating
        ? "the last 6 failures alternate between the same two steps (A/B loop)"
        : exactCount >= STUCK_STOP_AFTER
          ? `the same ${tool} call failed identically ${exactCount} times with no file change in between`
          : `${errorCount} consecutive failures share the same error signature despite differently-spelled commands`;
      return { action: "stop", reason };
    }
    if (exactCount >= STUCK_WARN_AFTER || errorCount >= STUCK_ERROR_FOLD_WARN_AFTER) {
      const warnKey = exactCount >= STUCK_WARN_AFTER ? exactKey : errKey;
      const repeatedWarn = this.warned.has(warnKey);
      this.warned.add(warnKey);
      const reason = exactCount >= STUCK_WARN_AFTER
        ? `this exact ${tool} call has now failed ${exactCount} times in a row`
        : `${errorCount} recent failures produce the same underlying error even though the commands differ`;
      return { action: "warn", reason, repeatedWarn };
    }
    return { action: "none" };
  }

  /** Real progress (a successful file mutation) resets every streak. */
  reset(): void {
    this.exactStreaks.clear();
    this.errorStreaks.clear();
    this.recentKeys = [];
    this.warned.clear();
  }
}

export function buildStuckNudge(reason: string): string {
  return [
    `⚠ STUCK PATTERN: ${reason}.`,
    "Re-running it (or a re-spelled variant) will fail identically — the exit code will not change without a code or approach change.",
    "Either make the fix the error is pointing at, take a genuinely different approach, or report the blocker with `NEEDS USER:` and stop retrying.",
  ].join("\n");
}
