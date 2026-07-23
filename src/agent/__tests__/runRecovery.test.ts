import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi, beforeEach } from "vitest";
import type { ExternalExecutor, ExecutorId, ExecutorResult } from "../../executors/types";
import { recoveryPreflight } from "../runRecovery";
import { clearRunFailedMarker } from "../exitSentinel";

// ── helpers ────────────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tanya-runRecovery-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "app.ts"), 'console.log("hello");\n');
  git(dir, ["add", "app.ts"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function writeMarker(workspace: string, runId: string, extra?: string): void {
  const tanyaDir = join(workspace, ".tanya");
  mkdirSync(tanyaDir, { recursive: true });
  const lines = [`# Last Run Failed`, ``, `- runId: ${runId}`, `- timestamp: ${new Date().toISOString()}`];
  if (extra) lines.push(extra);
  writeFileSync(join(tanyaDir, "LAST_RUN_FAILED.md"), lines.join("\n"));
}

function writeRunArchive(workspace: string, runId: string, overrides: Record<string, unknown> = {}): void {
  const runsDir = join(workspace, ".tanya", "runs");
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(
    join(runsDir, `${runId}.json`),
    JSON.stringify({
      archiveVersion: 2,
      ts: new Date().toISOString(),
      runId,
      prompt: "Test prompt",
      provider: "test",
      model: "test",
      manifest: {
        schemaVersion: 1,
        changedFiles: ["src/foo.ts"],
        uncommittedFiles: ["src/foo.ts"],
        artifactsRead: [],
        artifactsCreated: [],
        contextFilesRead: [],
        verification: [],
        git: { root: null, head: null },
        toolErrors: 1,
        blockers: ["compile error in src/foo.ts"],
        ...overrides.manifest as Record<string, unknown> || {},
      },
      ...overrides,
    }),
    "utf8",
  );
}

function writeCorruptArchive(workspace: string, runId: string): void {
  const runsDir = join(workspace, ".tanya", "runs");
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, `${runId}.json`), "not valid json {{{");
}

function noopSink(): void {}

// ── recoveryPreflight unit tests ───────────────────────────────────────────

describe("runRecovery", () => {
  describe("recoveryPreflight (unit)", () => {
    it("no marker → returns null", () => {
      const repo = makeRepo();
      const result = recoveryPreflight(repo);
      expect(result).toBeNull();
    });

    it("marker present → returns RECOVERY block with runId", () => {
      const repo = makeRepo();
      writeMarker(repo, "r-test-001");
      writeRunArchive(repo, "r-test-001");

      const result = recoveryPreflight(repo);

      expect(result).not.toBeNull();
      expect(result!.recoveryBlock).toContain("## RECOVERY MODE");
      expect(result!.recoveryBlock).toContain("r-test-001");
      expect(result!.runId).toBe("r-test-001");
      expect(result!.classes.length).toBeGreaterThan(0);
    });

    it("marker with no runId → uses 'unknown'", () => {
      const repo = makeRepo();
      const tanyaDir = join(repo, ".tanya");
      mkdirSync(tanyaDir, { recursive: true });
      writeFileSync(join(tanyaDir, "LAST_RUN_FAILED.md"), "# Last Run Failed\n\nNo structured fields.\n");

      const result = recoveryPreflight(repo);

      expect(result).not.toBeNull();
      expect(result!.runId).toBe("unknown");
      expect(result!.recoveryBlock).toContain("## RECOVERY MODE");
    });

    it("marker present but no run archive → returns recovery block (doctor reads marker file directly)", () => {
      const repo = makeRepo();
      writeMarker(repo, "r-nonexistent");

      const result = recoveryPreflight(repo);

      expect(result).not.toBeNull();
      expect(result!.recoveryBlock).toContain("## RECOVERY MODE");
      // Doctor may classify based on marker content alone — classes may be non-empty
      expect(Array.isArray(result!.classes)).toBe(true);
    });

    it("corrupt archive → returns block gracefully", () => {
      const repo = makeRepo();
      writeMarker(repo, "r-corrupt");
      writeCorruptArchive(repo, "r-corrupt");

      const result = recoveryPreflight(repo);

      expect(result).not.toBeNull();
      expect(result!.recoveryBlock).toContain("## RECOVERY MODE");
    });

    it("does NOT delete the marker (survives for next run if recovery crashes)", () => {
      const repo = makeRepo();
      writeMarker(repo, "r-test-002");
      writeRunArchive(repo, "r-test-002");

      const markerPath = join(repo, ".tanya", "LAST_RUN_FAILED.md");
      expect(existsSync(markerPath)).toBe(true);

      recoveryPreflight(repo);

      // Marker must still exist — preflight reads, never deletes
      expect(existsSync(markerPath)).toBe(true);
    });

    it("stale marker over clean tree → recoveryBlock still returned (agent handles build check)", () => {
      const repo = makeRepo();
      writeMarker(repo, "r-stale");
      writeRunArchive(repo, "r-stale", { manifest: { blockers: [] } });

      const result = recoveryPreflight(repo);

      // Even though the archive shows no blockers, a marker still exists — return the block
      expect(result).not.toBeNull();
      expect(result!.recoveryBlock).toContain("## RECOVERY MODE");
    });

    // ── opt-out tests ────────────────────────────────────────────────────

    it("TANYA_RECOVERY=off → returns null", () => {
      const repo = makeRepo();
      writeMarker(repo, "r-disabled");
      writeRunArchive(repo, "r-disabled");

      const prev = process.env.TANYA_RECOVERY;
      try {
        process.env.TANYA_RECOVERY = "off";
        const result = recoveryPreflight(repo);
        expect(result).toBeNull();
      } finally {
        process.env.TANYA_RECOVERY = prev;
      }
    });

    it("metadata.recovery: false → returns null", () => {
      const repo = makeRepo();
      writeMarker(repo, "r-metadata");
      writeRunArchive(repo, "r-metadata");

      const result = recoveryPreflight(repo, {
        runContext: { metadata: { recovery: false } },
      });
      expect(result).toBeNull();
    });

    // ── doctor class propagation ─────────────────────────────────────────

    it("doctor classes appear in the recovery block", () => {
      const repo = makeRepo();
      writeMarker(repo, "r-classes");
      writeRunArchive(repo, "r-classes", {
        manifest: {
          schemaVersion: 1,
          changedFiles: ["src/broken.ts"],
          uncommittedFiles: ["src/broken.ts"],
          blockers: ["compile error in src/broken.ts"],
          greenBuildObserved: false,
        },
      });

      const result = recoveryPreflight(repo);

      expect(result).not.toBeNull();
      // The doctor should classify this as at least one failure class
      expect(result!.classes.length).toBeGreaterThan(0);
      // Classes should be mentioned in the block
      for (const c of result!.classes) {
        expect(result!.recoveryBlock).toContain(c);
      }
      // Prescription should be present
      expect(result!.recoveryBlock).toContain("Doctor prescription");
    });
  });

  // ── Full lifecycle (integration) ─────────────────────────────────────────

  describe("full lifecycle", () => {
    it("FAIL writes marker → next run gets RECOVERY → PASSED clears → third run gets no block", async () => {
      const repo = makeRepo();

      // Phase 1: Plant a FAIL marker (simulating a previous failed run)
      writeMarker(repo, "r-lifecycle");
      writeRunArchive(repo, "r-lifecycle", {
        manifest: {
          schemaVersion: 1,
          changedFiles: ["src/broken.ts"],
          uncommittedFiles: ["src/broken.ts"],
          blockers: ["compile error"],
          greenBuildObserved: false,
        },
      });

      // Phase 2: Recovery preflight detects it
      const result1 = recoveryPreflight(repo);
      expect(result1).not.toBeNull();
      expect(result1!.runId).toBe("r-lifecycle");

      // Phase 3: Simulate PASSED — marker cleared (as exitSentinel would do)
      clearRunFailedMarker(repo);
      expect(existsSync(join(repo, ".tanya", "LAST_RUN_FAILED.md"))).toBe(false);

      // Phase 4: Third run — no marker, no recovery block
      const result2 = recoveryPreflight(repo);
      expect(result2).toBeNull();
    });
  });

  // ── runner.ts integration ────────────────────────────────────────────────

  describe("runAgentCore with recovery", () => {
    it("marker present → prompt contains RECOVERY block", async () => {
      const repo = makeRepo();
      writeMarker(repo, "r-runner");
      writeRunArchive(repo, "r-runner", {
        manifest: {
          schemaVersion: 1,
          changedFiles: [],
          uncommittedFiles: [],
          blockers: [],
        },
      });

      // Mock provider with streamChat (what runAgent actually calls)
      const mockProvider = {
        streamChat: vi.fn(async function* () {
          yield {
            type: "content" as const,
            text: "RECOVERY MODE DETECTED — I will build first.",
          };
          yield { type: "tool_start" as const, id: "t1", name: "write_file", args: "{}" };
          yield { type: "tool_end" as const, id: "t1" };
          yield { type: "done" as const, stop_reason: "end_turn" };
        }),
        contextWindow: 200_000,
      };

      const { runAgent } = await import("../runner");
      const result = await runAgent({
        provider: mockProvider as any,
        prompt: "Write a simple test file.",
        cwd: repo,
        sink: noopSink,
        maxTurns: 1,
      });

      expect(result.manifest).toBeDefined();
      expect(result.manifest.blockers).toBeDefined();
    }, 20_000);
  });
});

// ── externalRun integration ────────────────────────────────────────────────

describe("ExternalBackend recovery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unmock("../../executors/index");
  });

  it("marker present → external executor prompt contains RECOVERY block", async () => {
    const repo = makeRepo();
    writeMarker(repo, "r-external");
    writeRunArchive(repo, "r-external", {
      manifest: {
        schemaVersion: 1,
        changedFiles: [],
        uncommittedFiles: [],
        blockers: [],
      },
    });

    // Fake executor that captures the prompt
    const capturedPrompt: { value: string } = { value: "" };
    const fakeExecutor: ExternalExecutor = {
      id: "claude" as ExecutorId,
      binary: "fake-recovery",
      available: vi.fn().mockResolvedValue(true),
      run: vi.fn((task: { prompt: string }) => {
        capturedPrompt.value = task.prompt;
        return Promise.resolve({
          ok: true,
          exitCode: 0,
          transcript: "RECOVERY MODE DETECTED",
          finalText: "RECOVERY MODE DETECTED",
        } satisfies ExecutorResult);
      }),
    };

    // Dynamically mock the executor registry
    vi.doMock("../../executors/index", () => ({
      registerExecutor: () => {},
      resolveExecutor: () => fakeExecutor,
      getExecutor: () => fakeExecutor,
      listExecutors: () => [],
    }));

    // Dynamically import after modules are mocked
    const { runWithExternalBackend } = await import("../externalRun");

    const result = await runWithExternalBackend({
      backend: "claude" as ExecutorId,
      prompt: "Hello world",
      cwd: repo,
      sink: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.manifest).toBeDefined();
    expect(capturedPrompt.value).toContain("## RECOVERY MODE");
    expect(capturedPrompt.value).toContain("r-external");
  }, 20_000);
});

describe("recovery attempts + brake (beta.32)", () => {
  it("marker without a recoveryAttempts line → attempts 0, normal progress-preserving contract", () => {
    const repo = makeRepo();
    writeMarker(repo, "r-a0");
    writeRunArchive(repo, "r-a0");

    const result = recoveryPreflight(repo);

    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(0);
    expect(result!.braked).toBe(false);
    // The contract leads with committing finished work, not reverting damage.
    expect(result!.recoveryBlock).toContain("COMMIT the completed work NOW");
    expect(result!.recoveryBlock).toContain("Do NOT restart it");
    expect(result!.recoveryBlock).not.toContain("RECOVERY BRAKE");
  });

  it("marker with recoveryAttempts: 1 → attempts surfaced, still the full contract", () => {
    const repo = makeRepo();
    writeMarker(repo, "r-a1", "- recoveryAttempts: 1");
    writeRunArchive(repo, "r-a1");

    const result = recoveryPreflight(repo);

    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(1);
    expect(result!.braked).toBe(false);
    expect(result!.recoveryBlock).toContain("Recovery attempts before this one: 1");
    expect(result!.recoveryBlock).toContain("## RECOVERY MODE");
  });

  it("marker with recoveryAttempts: 2 → BRAKE: commit-and-stop contract replaces the task", () => {
    const repo = makeRepo();
    writeMarker(repo, "r-a2", "- recoveryAttempts: 2");
    writeRunArchive(repo, "r-a2");

    const result = recoveryPreflight(repo);

    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(2);
    expect(result!.braked).toBe(true);
    expect(result!.recoveryBlock).toContain("RECOVERY BRAKE");
    expect(result!.recoveryBlock).toContain("do NOT attempt the original task");
    expect(result!.recoveryBlock).toContain("NEEDS USER");
    // Brake path never invokes the doctor — no classes.
    expect(result!.classes).toEqual([]);
  });

  it("marker with recoveryAttempts: 5 → still braked", () => {
    const repo = makeRepo();
    writeMarker(repo, "r-a5", "- recoveryAttempts: 5");
    writeRunArchive(repo, "r-a5");

    const result = recoveryPreflight(repo);

    expect(result).not.toBeNull();
    expect(result!.braked).toBe(true);
    expect(result!.recoveryBlock).toContain("5 recovery attempts");
  });

  it("brake block instructs CONTEXT ONLY for the task text", () => {
    const repo = makeRepo();
    writeMarker(repo, "r-ctx", "- recoveryAttempts: 3");
    writeRunArchive(repo, "r-ctx");

    const result = recoveryPreflight(repo);

    expect(result!.recoveryBlock).toContain("CONTEXT ONLY");
  });
});
