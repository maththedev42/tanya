import { describe, expect, it } from "vitest";
import { prependRecoveryBlock, stripRecoveryPreamble, RECOVERY_TASK_SEPARATOR } from "../recoveryPrompt";
import { parseSpecRequirements } from "../specCoverage";
import { interactiveTaskGatesArmed } from "../taskGating";

// A recovery block shaped like the real one, including the doctor
// prescription's `### Part N` headings that caused the r-mrtlzbyi false FAIL.
const RECOVERY_BLOCK = [
  "## RECOVERY MODE — last run failed",
  "",
  "Previous run `r-prev` finalized as FAIL.",
  "",
  "**Doctor prescription (read for context, do not execute verbatim unless correct):**",
  "",
  "## Parts",
  "### Part 1 — Build first",
  "### Part 2 — Repair or revert",
  "### Part 3 — Re-dispatch",
  "",
  "## Contract — in THIS order, before anything else",
  "1. Check state cheaply: `npx tsc --noEmit`, xcodebuild.",
  "2. COMMIT the completed work NOW.",
].join("\n");

const TASK = [
  "# Sellability program",
  "",
  "## P0 — domain rescue",
  "manual",
  "",
  "## P5 — store submission",
  "manual",
].join("\n");

describe("stripRecoveryPreamble", () => {
  it("passes a plain prompt through untouched", () => {
    expect(stripRecoveryPreamble(TASK)).toBe(TASK);
    expect(stripRecoveryPreamble(undefined)).toBe("");
    expect(stripRecoveryPreamble("")).toBe("");
  });

  it("returns the original task from a recovery-prefixed prompt (round-trip)", () => {
    const joined = prependRecoveryBlock(RECOVERY_BLOCK, TASK);
    expect(joined).toContain(RECOVERY_TASK_SEPARATOR);
    expect(stripRecoveryPreamble(joined)).toBe(TASK);
  });

  it("handles a RECOVERY BRAKE prefix the same way", () => {
    const brakeBlock = "## RECOVERY BRAKE — do NOT attempt the original task\n\ncommit and stop.";
    expect(stripRecoveryPreamble(prependRecoveryBlock(brakeBlock, TASK))).toBe(TASK);
  });

  it("leaves a recovery-looking prompt WITHOUT the separator untouched (never guess a split)", () => {
    const noSeparator = "## RECOVERY MODE — last run failed\n\nsome text, no actual-task marker";
    expect(stripRecoveryPreamble(noSeparator)).toBe(noSeparator);
  });

  it("only strips a LEADING recovery block — a task that merely mentions one is untouched", () => {
    const mentions = `# My task\n\nQuote: "## RECOVERY MODE" appears in docs.\n\n${RECOVERY_TASK_SEPARATOR}\nnot a real split`;
    expect(stripRecoveryPreamble(mentions)).toBe(mentions);
  });
});

describe("regression: recovery preamble must not create phantom gate requirements", () => {
  it("spec requirements come only from the user's task, never the doctor prescription", () => {
    const joined = prependRecoveryBlock(RECOVERY_BLOCK, TASK);
    const ids = parseSpecRequirements(stripRecoveryPreamble(joined)).map((requirement) => requirement.id);
    expect(ids).not.toContain("Part 2");
    expect(ids).not.toContain("Part 3");
    // The task's own sections still register.
    expect(ids.join(",")).toContain("P0");
  });

  it("a plain chat turn after a FAIL does not become task-shaped via the recovery block", () => {
    const chatAfterFail = prependRecoveryBlock(RECOVERY_BLOCK, "oi, tudo bem? o que aconteceu no último run?");
    expect(interactiveTaskGatesArmed({
      interactive: true,
      changed: [],
      prompt: chatAfterFail,
    })).toBe(false);
  });
});
