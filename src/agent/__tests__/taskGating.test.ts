import { afterEach, describe, expect, it } from "vitest";
import { interactiveTaskGatesArmed, promptHasTaskShape, taskCompletionGatesArmed, taskGatesDisabled } from "../taskGating";
import type { TanyaRunContext } from "../../context/runContext";

const rc = (v: unknown): TanyaRunContext => v as TanyaRunContext;
const coding = rc({ task: { kind: "coding", title: "t" } });

const TASK_PROMPT = "# FIX-01\n\n## Part 1\nDo a thing.\n\n## Part 2\nDo another.\n\n## Verify\nRun `xcodebuild build`.";
const VERIFY_PROMPT = "Fix the crash.\n\n## Verify\nRun `go build ./...` and paste output.";
const CHAT_PROMPT = "what does this function do?";

afterEach(() => {
  delete process.env.TANYA_TASK_GATES;
});

describe("promptHasTaskShape", () => {
  it("is true for ≥2 numbered deliverables", () => {
    expect(promptHasTaskShape(TASK_PROMPT)).toBe(true);
  });
  it("is true for a ## Verify section with a command", () => {
    expect(promptHasTaskShape(VERIFY_PROMPT)).toBe(true);
  });
  it("is false for a plain chat prompt", () => {
    expect(promptHasTaskShape(CHAT_PROMPT)).toBe(false);
  });
  it("is false for empty", () => {
    expect(promptHasTaskShape("")).toBe(false);
  });
});

describe("interactiveTaskGatesArmed", () => {
  it("arms a task-shaped interactive prompt even with no runContext (the mac-app hole)", () => {
    expect(interactiveTaskGatesArmed({ interactive: true, changed: [], prompt: TASK_PROMPT })).toBe(true);
  });
  it("arms an interactive coding turn that changed files", () => {
    expect(interactiveTaskGatesArmed({ interactive: true, runContext: coding, changed: ["a.swift"], prompt: "add x" })).toBe(true);
  });
  it("does NOT arm a coding turn that changed nothing and isn't task-shaped", () => {
    expect(interactiveTaskGatesArmed({ interactive: true, runContext: coding, changed: [], prompt: "explain this" })).toBe(false);
  });
  it("does NOT arm a bare interactive chat turn", () => {
    expect(interactiveTaskGatesArmed({ interactive: true, changed: ["a.swift"], prompt: CHAT_PROMPT })).toBe(false);
  });
  it("is always false for a non-interactive run (handled elsewhere)", () => {
    expect(interactiveTaskGatesArmed({ interactive: false, changed: [], prompt: TASK_PROMPT })).toBe(false);
  });
  it("respects TANYA_TASK_GATES=off", () => {
    process.env.TANYA_TASK_GATES = "off";
    expect(interactiveTaskGatesArmed({ interactive: true, changed: [], prompt: TASK_PROMPT })).toBe(false);
  });
  it("respects metadata.taskGates === false", () => {
    expect(interactiveTaskGatesArmed({
      interactive: true,
      runContext: rc({ task: { kind: "coding" }, metadata: { taskGates: false } }),
      changed: ["a.swift"],
      prompt: TASK_PROMPT,
    })).toBe(false);
  });
});

describe("taskGatesDisabled", () => {
  it("false by default", () => {
    expect(taskGatesDisabled(undefined)).toBe(false);
  });
  it("true when metadata opts out", () => {
    expect(taskGatesDisabled(rc({ metadata: { taskGates: false } }))).toBe(true);
  });
  it.each(["0", "false", "off", "no", "OFF"])("true when TANYA_TASK_GATES=%s", (v) => {
    process.env.TANYA_TASK_GATES = v;
    expect(taskGatesDisabled(undefined)).toBe(true);
  });
});

describe("taskCompletionGatesArmed", () => {
  it("is true for any non-interactive run", () => {
    expect(taskCompletionGatesArmed({ interactive: false, changed: [], prompt: CHAT_PROMPT })).toBe(true);
  });
  it("is true for an interactive task", () => {
    expect(taskCompletionGatesArmed({ interactive: true, changed: [], prompt: TASK_PROMPT })).toBe(true);
  });
  it("is false for an interactive chat turn", () => {
    expect(taskCompletionGatesArmed({ interactive: true, changed: [], prompt: CHAT_PROMPT })).toBe(false);
  });
});
