import type { TanyaRunContext } from "../context/runContext";
import { offFlag } from "../config/runtimeFlags";
import { parseSpecRequirements } from "./specCoverage";
import { parseVerifyCommands } from "./verifyGate";
import { stripRecoveryPreamble } from "./recoveryPrompt";

// Intent gating, not transport gating.
//
// The mac app (and any `tanya serve` client) runs every turn with
// `interactive: true` — see serveStdio.ts. Before this, every hard gate and the
// FAILED verdict itself were guarded by `!interactive`, so a real engineering
// task pasted into the mac app ("# FIX-01 … 10 items … ## Verify: xcodebuild")
// was gated exactly like "what's the capital of France?" — i.e. not at all.
// That is the whole reason the beta.9 gates were reproduced-through by the very
// next runs (see docs/gate-escape-2026-07-13.md, E1/E3/E6/E8).
//
// `interactive` describes the transport, not the intent. This module decides
// whether an interactive turn is actually a TASK we should hold to completion
// gates: a coding task that changed files, or any prompt carrying task structure
// (≥2 numbered deliverables, or a `## Verify` / `## Acceptance` section). A plain
// conversational turn is neither, so it stays on the soft-warning path and a
// working app is never false-failed.

/** Local copy of report.ts's isCodingTask to avoid an import cycle
 *  (report.ts imports this module). Kept in lockstep with report.ts. */
function isCodingRun(runContext?: TanyaRunContext): boolean {
  return runContext?.task?.kind === "coding" || Boolean(runContext?.expected_report);
}

/** A prompt is "task-shaped" when it enumerates deliverables or a verification
 *  contract — the shape of every escaped run (FIX-01, TANYA-11, FIX2-01). This is
 *  what lets us gate a pasted task even when the coding-intent heuristic that
 *  assigns a runContext (interactiveBudget.ts) doesn't recognise it. */
export function promptHasTaskShape(prompt: string): boolean {
  if (!prompt) return false;
  return parseSpecRequirements(prompt).length >= 2 || parseVerifyCommands(prompt).length > 0;
}

/** Escape hatch: TANYA_TASK_GATES=0|false|off|no disables interactive task
 *  gating entirely, and `metadata.taskGates === false` opts a single run out. */
export function taskGatesDisabled(runContext?: TanyaRunContext): boolean {
  if (runContext?.metadata?.taskGates === false) return true;
  return !offFlag("TANYA_TASK_GATES");
}

/** Whether an INTERACTIVE turn should be held to task-completion gates. False for
 *  non-interactive runs (those keep their existing `!interactive` behaviour) and
 *  for plain chat turns. */
export function interactiveTaskGatesArmed(params: {
  interactive?: boolean | undefined;
  runContext?: TanyaRunContext | undefined;
  changed: string[];
  prompt?: string | undefined;
}): boolean {
  if (!params.interactive) return false;
  if (taskGatesDisabled(params.runContext)) return false;
  // A structured task prompt is unambiguously a task, regardless of runContext.
  // Task shape must come from the USER's prompt — the recovery preamble is a
  // structured contract too, and without the strip it would make every
  // post-FAIL chat turn look like a task (defense in depth; report.ts strips
  // before calling, but the runner's interactiveTask() passes the raw prompt).
  if (promptHasTaskShape(stripRecoveryPreamble(params.prompt))) return true;
  // Otherwise, a coding turn that actually wrote files is a task too.
  return isCodingRun(params.runContext) && params.changed.length > 0;
}

/** The unified "hold this run to task-completion gates" predicate, covering both
 *  transports: non-interactive runs (ad-hoc CLI / pipeline) keep firing as
 *  before; interactive runs fire only when they are a task. */
export function taskCompletionGatesArmed(params: {
  interactive?: boolean | undefined;
  runContext?: TanyaRunContext | undefined;
  changed: string[];
  prompt?: string | undefined;
}): boolean {
  return !params.interactive || interactiveTaskGatesArmed(params);
}

/** Human-readable "why the gates armed (or didn't)" for the run archive. Mirrors
 *  the arming predicates above so an auditor sees the decision, not just its
 *  boolean outcome. */
export function armingReason(params: {
  interactive?: boolean | undefined;
  runContext?: TanyaRunContext | undefined;
  changed: string[];
  prompt?: string | undefined;
}): string {
  const files = (n: number) => `${n} file${n === 1 ? "" : "s"} changed`;
  if (taskGatesDisabled(params.runContext)) {
    return "disarmed: task gates disabled (TANYA_TASK_GATES / metadata.taskGates=false)";
  }
  if (!params.interactive) return `non-interactive run (${files(params.changed.length)})`;
  const taskPrompt = stripRecoveryPreamble(params.prompt);
  if (promptHasTaskShape(taskPrompt)) {
    const deliverables = parseSpecRequirements(taskPrompt).length;
    const verifyCommands = parseVerifyCommands(taskPrompt).length;
    return `task-shaped prompt (${deliverables} deliverable${deliverables === 1 ? "" : "s"}, ${verifyCommands} verify command${verifyCommands === 1 ? "" : "s"})`;
  }
  if (isCodingRun(params.runContext) && params.changed.length > 0) {
    return `coding task: ${files(params.changed.length)}`;
  }
  return "disarmed: conversational turn (no task shape, no files changed)";
}
