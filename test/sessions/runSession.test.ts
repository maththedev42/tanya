import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunAgentResult } from "../../src/agent/runner";
import { persistRunSession, runSessionLabel, runSessionsDisabled } from "../../src/sessions/runSession";
import { listSessions, loadSession } from "../../src/sessions/storage";

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "tanya-run-session-"));
  mkdirSync(join(cwd, ".tanya"), { recursive: true });
  return cwd;
}

function fakeResult(message: string): RunAgentResult {
  return {
    message,
    manifest: { blockers: [] },
    metrics: { promptTokens: 100, completionTokens: 50, reasoningTokens: 0 },
  } as unknown as RunAgentResult;
}

describe("persistRunSession", () => {
  it("saves one turn per attempt and the session is loadable + resumable", () => {
    const cwd = project();
    const session = persistRunSession({
      cwd,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      taskPrompt: "Test the iOS app at runtime, check the errors, report them, and fix them.",
      attempts: [
        { prompt: "Test the iOS app...", message: "Found 3 issues.", startedAt: 1_000, elapsedMs: 60_000, result: fakeResult("Found 3 issues.") },
        { prompt: "Previous run blockers:\n- UI issue ...", message: "Fixed all issues. TANYA RESULT: PASSED", startedAt: 70_000, elapsedMs: 50_000, result: fakeResult("Fixed all issues. TANYA RESULT: PASSED") },
      ],
    });
    expect(session).not.toBeNull();
    const loaded = loadSession(session?.id ?? "", { cwd });
    expect(loaded.session.turns).toHaveLength(4); // 2 attempts × (user + assistant)
    expect(loaded.session.turns[0]?.content).toContain("Test the iOS app");
    expect(loaded.session.turns.at(-1)?.content).toContain("TANYA RESULT: PASSED");
    // It shows up in the same list /resume's picker uses.
    const listed = listSessions({ cwd });
    expect(listed.map((s) => s.id)).toContain(session?.id);
    expect(listed.find((s) => s.id === session?.id)?.label).toBe(
      "run · Test the iOS app at runtime, check the errors, report them, and…",
    );
  });

  it("returns null with no attempts", () => {
    expect(
      persistRunSession({ cwd: project(), provider: "p", model: "m", taskPrompt: "x", attempts: [] }),
    ).toBeNull();
  });
});

describe("runSessionLabel", () => {
  it("uses the first non-empty line, truncated", () => {
    expect(runSessionLabel("\n\nFix the calculator\nmore detail")).toBe("run · Fix the calculator");
    expect(runSessionLabel("a".repeat(100))).toBe(`run · ${"a".repeat(63)}…`);
    expect(runSessionLabel("  ")).toBe("run · (no prompt)");
  });
});

describe("runSessionsDisabled", () => {
  it("only disables on explicit falsy values", () => {
    expect(runSessionsDisabled({})).toBe(false);
    expect(runSessionsDisabled({ TANYA_RUN_SESSIONS: "1" })).toBe(false);
    expect(runSessionsDisabled({ TANYA_RUN_SESSIONS: "0" })).toBe(true);
    expect(runSessionsDisabled({ TANYA_RUN_SESSIONS: "off" })).toBe(true);
  });
});
