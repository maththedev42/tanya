import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { clearRunFailedMarker, writeRunFailedMarker } from "../exitSentinel";
import { repairAttemptBudget } from "../runner";
import type { RunAgentOptions } from "../runner";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tanya-failmarker-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("graceful-FAIL marker (never end silently on a known FAIL)", () => {
  it("writes a structured LAST_RUN_FAILED.md with blockers, files, attempts, and the doctor pointer", () => {
    const workspace = tmpDir();
    writeRunFailedMarker({
      workspace,
      runId: "r-fail-1",
      blockers: ["failed verification: xcodebuild -> failed (Command exited 65.)"],
      changedFiles: ["App/BillsView.swift"],
      uncommittedFiles: ["App/BillsView.swift"],
      repairAttemptsUsed: 2,
    });
    const markerPath = join(workspace, ".tanya", "LAST_RUN_FAILED.md");
    expect(existsSync(markerPath)).toBe(true);
    const body = readFileSync(markerPath, "utf8");
    expect(body).toContain("FINALIZED AS FAIL");
    expect(body).toContain("failed verification: xcodebuild");
    expect(body).toContain("App/BillsView.swift");
    expect(body).toContain("repair attempts used before finalizing FAIL: 2");
    expect(body).toContain("tanya doctor --run r-fail-1");
  });

  it("clearRunFailedMarker removes it, and is a no-op when absent", () => {
    const workspace = tmpDir();
    writeRunFailedMarker({
      workspace,
      runId: "r-fail-2",
      blockers: ["x"],
      changedFiles: [],
      uncommittedFiles: [],
    });
    const markerPath = join(workspace, ".tanya", "LAST_RUN_FAILED.md");
    expect(existsSync(markerPath)).toBe(true);
    clearRunFailedMarker(workspace);
    expect(existsSync(markerPath)).toBe(false);
    clearRunFailedMarker(workspace);
    expect(existsSync(markerPath)).toBe(false);
  });
});

describe("repairAttemptBudget — interactive task arming", () => {
  function options(cwd: string): RunAgentOptions {
    return { cwd } as unknown as RunAgentOptions;
  }

  it("stays 0 for a non-coding, non-interactive-task run", () => {
    expect(repairAttemptBudget(options(tmpDir()))).toBe(0);
  });

  it("arms for an interactive task-shaped run (the mac-app dispatch path)", () => {
    // Non-TS workspace default is 2; the point is it is no longer 0.
    expect(repairAttemptBudget(options(tmpDir()), true)).toBe(2);
  });

  it("explicit configuration still wins and clamps", () => {
    const opts = { cwd: tmpDir(), repairAttempts: 9 } as unknown as RunAgentOptions;
    expect(repairAttemptBudget(opts, false)).toBe(5);
    const zero = { cwd: tmpDir(), repairAttempts: 0 } as unknown as RunAgentOptions;
    expect(repairAttemptBudget(zero, true)).toBe(0);
  });
});

describe("recoveryAttempts on the marker (beta.32 brake input)", () => {
  it("writes the recoveryAttempts line when the failed run was a recovery run", () => {
    const workspace = tmpDir();
    writeRunFailedMarker({
      workspace,
      runId: "r-rec-1",
      blockers: ["token budget exhausted before final completion (stalled with no progress)"],
      changedFiles: [],
      uncommittedFiles: [],
      recoveryAttempts: 2,
    });
    const body = readFileSync(join(workspace, ".tanya", "LAST_RUN_FAILED.md"), "utf8");
    expect(body).toContain("- recoveryAttempts: 2");
  });

  it("omits the line for a first (non-recovery) failure, and for 0", () => {
    const workspace = tmpDir();
    writeRunFailedMarker({
      workspace,
      runId: "r-rec-0",
      blockers: ["x"],
      changedFiles: [],
      uncommittedFiles: [],
      recoveryAttempts: 0,
    });
    const body = readFileSync(join(workspace, ".tanya", "LAST_RUN_FAILED.md"), "utf8");
    expect(body).not.toContain("recoveryAttempts");
  });
});
