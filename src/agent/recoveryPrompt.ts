// The recovery preflight prepends a RECOVERY block to the dispatched task
// prompt. That block is INSTRUCTIONS ABOUT THE WORKSPACE, not part of the
// user's task — but it is markdown with headings, numbered contracts, shell
// commands, and (via the embedded doctor prescription) `### Part N` sections.
// Every gate that parses "the prompt" for task semantics (spec deliverables,
// verify commands, commit intent, task-shape arming, deferral citations) must
// therefore see the ORIGINAL task only, or the recovery machinery's own words
// become phantom requirements. Observed 2026-07-20 (r-mrtlzbyi): a run that
// did everything green false-FAILed on "Part 2, Part 3" — headings that
// existed only inside the doctor prescription embedded in its recovery block.
//
// Zero imports on purpose: this module is consumed by both the gate layer
// (report.ts, taskGating.ts) and the run layer (runner.ts, externalRun.ts),
// and must never create a cycle between them.

/** Heading that separates the recovery block from the user's real task. Both
 *  runners join with this exact line; the strip looks for the same line. */
export const RECOVERY_TASK_SEPARATOR = "## ACTUAL TASK";

const RECOVERY_PREFIXES = ["## RECOVERY MODE", "## RECOVERY BRAKE"];

/** Build the dispatched prompt: recovery block, separator, original task. */
export function prependRecoveryBlock(recoveryBlock: string, taskPrompt: string): string {
  return [recoveryBlock, "---", RECOVERY_TASK_SEPARATOR, "", taskPrompt].join("\n");
}

/** Return the user's original task from a possibly recovery-prefixed prompt.
 *  Prompts without a recovery prefix pass through untouched; a recovery
 *  prefix without the separator (never produced by our runners) also passes
 *  through rather than guessing at a split. */
export function stripRecoveryPreamble(prompt: string | undefined): string {
  if (!prompt) return "";
  if (!RECOVERY_PREFIXES.some((prefix) => prompt.startsWith(prefix))) return prompt;
  const separatorIndex = prompt.indexOf(`\n${RECOVERY_TASK_SEPARATOR}\n`);
  if (separatorIndex === -1) return prompt;
  return prompt.slice(separatorIndex + RECOVERY_TASK_SEPARATOR.length + 2).replace(/^\n+/, "");
}
