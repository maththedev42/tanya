// Progress-aware turn budget. A fixed step cap stops a run the instant the count
// is hit — even mid-progress. With extension enabled a run has NO turn ceiling:
// it keeps going as long as it keeps making progress, and stops only when it
// genuinely stalls (no progress past the soft budget) or trips the token-runaway
// backstop. A task should never fail simply because it was long.
//
// Two deliberate constraints, learned from review:
//  - Opt-in only. Extension is enabled per-call (extendOnProgress), NOT inferred
//    from the turn count. Callers that pass an explicit hard cap (eval harness,
//    sub-agents, `--max-turns`, tests) must get EXACTLY that cap, so they never
//    opt in and behaviour is unchanged for them.
//  - Never early-stops WITHIN the soft budget. The runner already has purpose
//    built stuck-loop detection (shell-spiral, subtask-cycle, network-fallback,
//    no-tool-no-report). This module only adds extension past the budget; it
//    must not introduce a second, coarser stall-kill that fires on a cold start
//    or a normal failing compile→fix→compile loop.

export interface ProgressBudget {
  enabled: boolean;
  /** Loop bound. Infinity when extension is on and no explicit ceiling is set. */
  hardCeiling: number;
}

export interface ProgressBudgetOptions {
  extendOnProgress?: boolean;
  /** Optional explicit ceiling (e.g. from TANYA_HARD_TURN_CEILING). Unbounded when omitted. */
  ceiling?: number;
}

export function resolveProgressBudget(maxTurns: number, opts: ProgressBudgetOptions = {}): ProgressBudget {
  const enabled = Boolean(opts.extendOnProgress) && maxTurns > 0;
  if (!enabled) {
    return { enabled, hardCeiling: maxTurns };
  }
  const ceiling = opts.ceiling !== undefined && Number.isFinite(opts.ceiling) && opts.ceiling > 0
    ? Math.max(maxTurns, opts.ceiling)
    : Number.POSITIVE_INFINITY;
  return { enabled, hardCeiling: ceiling };
}

// Called at the start of each turn. Returns true only PAST the soft budget, once
// the previous turn made no progress. `lastProgressTurn` is the index of the
// most recent turn that made progress; turnsSinceProgress === 1 means the
// immediately-previous turn progressed (still extending). When extension is
// disabled, hardCeiling === maxTurns so the loop bound already enforces the cap
// and this always returns false — identical to the old fixed step cap.
export function shouldStopAfterBudget(
  turn: number,
  maxTurns: number,
  lastProgressTurn: number,
  budget: ProgressBudget,
): boolean {
  if (!budget.enabled) return false;
  if (turn < maxTurns) return false; // within the soft budget: never early-stop here
  return turn - lastProgressTurn >= 2; // past budget: stop once the last turn made no progress
}

// ---------------------------------------------------------------------------
// Wrap-up window. When a stop condition trips (no-progress stop or the
// token-runaway backstop), the run used to `break` SILENTLY — the model never
// learned it was out of budget, so finished work died uncommitted and the
// final report was a fallback. Observed 2026-07-20: a repair task needed 4
// runs (3 budget deaths) to land work that was DONE in the tree after run 1.
//
// Instead, the runner grants ONE fixed window of extra turns with an injected
// directive: commit completed work, write the final report, nothing else. The
// window is a hard deadline — progress made during wrap-up (commits count as
// progress) must NOT extend it, or a looping model would ride commits forever.
// ---------------------------------------------------------------------------

/** Extra turns granted after a budget/stall stop trips: enough for a
 *  path-limited commit (1–2 tool turns) plus the final report (1), no more. */
export const WRAP_UP_TURNS = 4;

export type WrapUpReason = "stall_tokens" | "no_progress";

export interface WrapUpState {
  startedTurn: number;
  reason: WrapUpReason;
}

/** True once a granted wrap-up window is spent — the loop must now stop
 *  regardless of any progress made during the window. */
export function wrapUpExpired(wrapUp: WrapUpState | null, turn: number): boolean {
  return wrapUp !== null && turn - wrapUp.startedTurn >= WRAP_UP_TURNS;
}

// ---------------------------------------------------------------------------
// Read-only drift guard. Reading NEW files counts as progress (correctly — a
// research phase must not trip the stall stops), which means a coding run can
// read forever without a single edit and no stop ever fires. Observed
// 2026-07-21: two runs burned 2.6M and 2.1M prompt tokens over 30+ tool calls
// with ZERO file changes, then finalized as soft PASSes — the model's own
// last words were "I spent the whole run just reading files and never wrote a
// single line of code." This guard delivers that confrontation at turn 8
// instead of after the budget: implement now, or say what blocks you.
//
// Armed only for coding-classified runs (runContext or task-shaped prompt) —
// a chat/explain turn is legitimately read-only and must never be nudged.
// Disarmed permanently by the FIRST successful mutation: a run that edited
// and then reads (verify phases, failing-build loops) is a different shape,
// covered by the stall stops and the wrap-up window.
// ---------------------------------------------------------------------------

/** First "stop researching, start implementing" nudge. */
export const DRIFT_FIRST_NUDGE_TURN = 8;
/** Sharper second nudge. */
export const DRIFT_SECOND_NUDGE_TURN = 16;
/** Still zero edits here → force the final report and end the run. */
export const DRIFT_WRAP_UP_TURN = 24;

export type DriftAction = "nudge" | "final_nudge" | "wrap_up" | null;

/** Called at the start of each turn. Exact-turn keying makes each stage fire
 *  at most once without extra bookkeeping. */
export function readOnlyDriftAction(turn: number, hasMutations: boolean, armed: boolean): DriftAction {
  if (!armed || hasMutations) return null;
  if (turn === DRIFT_FIRST_NUDGE_TURN) return "nudge";
  if (turn === DRIFT_SECOND_NUDGE_TURN) return "final_nudge";
  if (turn === DRIFT_WRAP_UP_TURN) return "wrap_up";
  return null;
}

export function buildDriftNudge(stage: "nudge" | "final_nudge"): string {
  if (stage === "nudge") {
    return [
      `⚠ READ-ONLY DRIFT — ${DRIFT_FIRST_NUDGE_TURN} turns and ZERO file edits. Research exists to serve edits, and this task expects implementation.`,
      "",
      "This turn, do ONE of:",
      "- Make the FIRST real edit (smallest correct change; you can refine after).",
      "- If a decision genuinely blocks you, write `NEEDS USER: <the question>` and stop.",
      "",
      "Do not open another file to \"confirm\" what you already know.",
    ].join("\n");
  }
  return [
    `⚠ READ-ONLY DRIFT (final warning) — ${DRIFT_SECOND_NUDGE_TURN} turns, still ZERO edits. If you know where the changes go, you have known for several turns.`,
    "",
    `Start implementing NOW. If you do not, at turn ${DRIFT_WRAP_UP_TURN} this run will be ended and your report will have to explain why nothing was written.`,
  ].join("\n");
}

/** Injected when the drift guard escalates: the run ends now, honestly. */
export function buildDriftWrapUpDirective(): string {
  return [
    `⛔ READ-ONLY DRIFT LIMIT — ${DRIFT_WRAP_UP_TURN} turns without a single edit. This run is over; you have ${WRAP_UP_TURNS} turns to close it.`,
    "",
    "Write your FINAL report NOW — no more reading:",
    "- What you learned, concretely (files, line areas, how the pieces connect).",
    "- The exact edits you WOULD make, per file, so the next run starts from them.",
    "- Why no edit was made this run — stated plainly.",
  ].join("\n");
}

/** The directive injected as a user message when the wrap-up window opens. */
export function buildWrapUpDirective(reason: WrapUpReason): string {
  const why = reason === "stall_tokens"
    ? "The run burned its token budget without recent progress."
    : "The run passed its turn budget without recent progress.";
  return [
    `⛔ BUDGET WALL — ${why} You have a wrap-up window of at most ${WRAP_UP_TURNS} turns. Do NOT start new work, new reads, new checks, or another attempt at whatever kept failing.`,
    "",
    "In this exact order:",
    "1. `git add` the finished, working files and COMMIT them path-limited (per normal rules). Skip only if nothing complete is uncommitted.",
    "2. Write your FINAL coding report NOW. List every remaining gap honestly — unfinished work reported as a gap is correct; unfinished work hidden or retried is not.",
    "",
    "Anything not done stays not done. The next run resumes from your commits and your report.",
  ].join("\n");
}
