import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../runner";
import { buildFinalManifest } from "../report";
import { captureGitSnapshot } from "../git";
import type { TanyaEvent } from "../../events/types";
import type { ChatProvider, ChatRequest, ToolCall } from "../../providers/types";

// Baseline-aware verification (Go-first). Real fixture, real `go test` — this
// is the exact stall shape from the 2026-07-14..16 cosmohq-v3 incident: a
// broad `go test ./...` failing only in a package the run never touched
// (`internal/store/apple`, broken by an unrelated earlier commit).

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function initGit(dir: string): void {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@e.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

// Two packages: `good` always passes; `broken` fails from the very first
// commit — a pre-existing red test, exactly like `internal/store/apple`.
function writeBrokenAtBaseFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "tanya-baseline-go-"));
  initGit(dir);
  writeFileSync(join(dir, "go.mod"), "module example.com/fixture\n\ngo 1.21\n");
  mkdirSync(join(dir, "good"), { recursive: true });
  writeFileSync(join(dir, "good", "good.go"), "package good\n\nfunc Add(a, b int) int { return a + b }\n");
  writeFileSync(join(dir, "good", "good_test.go"), 'package good\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal("bad")\n\t}\n}\n');
  mkdirSync(join(dir, "broken"), { recursive: true });
  writeFileSync(join(dir, "broken", "broken.go"), "package broken\n\nfunc AlwaysTrue() bool { return false }\n");
  writeFileSync(join(dir, "broken", "broken_test.go"), 'package broken\n\nimport "testing"\n\nfunc TestAlwaysTrue(t *testing.T) {\n\tif !AlwaysTrue() {\n\t\tt.Fatal("pre-existing failure")\n\t}\n}\n');
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init (broken/ already red)"]);
  return dir;
}

// Three packages: `good` always passes; `broken` imports `shared` and PASSES
// at base; editing `shared` (not `broken` itself) later flips `broken` red —
// a failure this run is responsible for despite never touching `broken/`.
function writeSharedDependencyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "tanya-baseline-go-shared-"));
  initGit(dir);
  writeFileSync(join(dir, "go.mod"), "module example.com/fixture\n\ngo 1.21\n");
  mkdirSync(join(dir, "good"), { recursive: true });
  writeFileSync(join(dir, "good", "good.go"), "package good\n\nfunc Add(a, b int) int { return a + b }\n");
  writeFileSync(join(dir, "good", "good_test.go"), 'package good\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal("bad")\n\t}\n}\n');
  mkdirSync(join(dir, "shared"), { recursive: true });
  writeFileSync(join(dir, "shared", "shared.go"), "package shared\n\nfunc Flag() bool { return true }\n");
  mkdirSync(join(dir, "broken"), { recursive: true });
  writeFileSync(join(dir, "broken", "broken.go"), 'package broken\n\nimport "example.com/fixture/shared"\n\nfunc Check() bool { return shared.Flag() }\n');
  writeFileSync(join(dir, "broken", "broken_test.go"), 'package broken\n\nimport "testing"\n\nfunc TestCheck(t *testing.T) {\n\tif !Check() {\n\t\tt.Fatal("check failed")\n\t}\n}\n');
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init (all green)"]);
  return dir;
}

function toolResultOutputs(events: TanyaEvent[]): string[] {
  return events
    .filter((event): event is Extract<TanyaEvent, { type: "tool_result" }> => event.type === "tool_result")
    .map((event) => String(event.output ?? ""));
}

describe("baseline-aware verification — early nudge (real go test via runAgent)", () => {
  it("nudges toward the untouched pre-existing failure without flipping ok", async () => {
    const dir = writeBrokenAtBaseFixture();
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        requests.push(input);
        if (requests.length === 1) {
          yield {
            toolCalls: [
              // Touch `good/` only.
              toolCall("w1", "write_file", { path: "good/good.go", content: "package good\n\n// touched\nfunc Add(a, b int) int { return a + b }\n" }),
              toolCall("c1", "run_shell", { script: "go test ./..." }),
            ],
          };
          return;
        }
        yield { content: "Done." };
      },
    };
    const events: TanyaEvent[] = [];

    await runAgent({
      provider,
      prompt: "Touch good/ and run the suite.",
      cwd: dir,
      sink: async (event) => { events.push(event); },
      maxTurns: 3,
    });

    const outputs = toolResultOutputs(events);
    const testResult = events.find((e) => e.type === "tool_result" && e.id === "c1");
    expect(testResult && testResult.type === "tool_result" && testResult.ok).toBe(false);
    const testOutput = outputs.find((o) => o.includes("were not touched by this run"));
    expect(testOutput).toBeDefined();
    // The nudge names exactly the failing (untouched) package — "good" only
    // ever appears in go test's own "ok  good  0.01s" line, not in the nudge's
    // failing-package list.
    expect(testOutput).toMatch(/failing package\(s\) example\.com\/fixture\/broken were not touched/);
    expect(testOutput).toMatch(/go test \.\/good\/\.\.\./);
  }, 60_000);

  it("does not nudge when the run touched the actually-failing package", async () => {
    const dir = writeBrokenAtBaseFixture();
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        requests.push(input);
        if (requests.length === 1) {
          yield {
            toolCalls: [
              toolCall("w1", "write_file", { path: "broken/broken.go", content: "package broken\n\n// touched, still broken\nfunc AlwaysTrue() bool { return false }\n" }),
              toolCall("c1", "run_shell", { script: "go test ./..." }),
            ],
          };
          return;
        }
        yield { content: "Done." };
      },
    };
    const events: TanyaEvent[] = [];

    await runAgent({
      provider,
      prompt: "Touch broken/ and run the suite.",
      cwd: dir,
      sink: async (event) => { events.push(event); },
      maxTurns: 3,
    });

    const outputs = toolResultOutputs(events);
    expect(outputs.some((o) => o.includes("were not touched by this run"))).toBe(false);
  }, 60_000);
});

describe("baseline-aware verification — finalize reclassification (worktree-verified)", () => {
  const ORIGINAL_BLOCKER = "failed verification: go test ./... -> failed (Command exited 1.)";

  function touchAndCommit(dir: string, relPath: string, content: string): void {
    writeFileSync(join(dir, relPath), content);
    git(dir, ["add", relPath]);
    git(dir, ["commit", "-q", "-m", `touch ${relPath}`]);
  }

  it("removes the blocker when the failure is confirmed pre-existing at the session base", async () => {
    const dir = writeBrokenAtBaseFixture();
    const before = await captureGitSnapshot(dir);
    // Simulate the run touching (and committing) only good/.
    touchAndCommit(dir, "good/good.go", "package good\n\n// touched\nfunc Add(a, b int) int { return a + b }\n");

    const manifest = await buildFinalManifest({
      workspace: dir,
      beforeGitSnapshot: before,
      changed: ["good/good.go"],
      verificationLines: ["Verification: go test ./... -> failed (Command exited 1.)"],
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      blockers: [ORIGINAL_BLOCKER],
      interactive: false,
    });

    expect(manifest.blockers).toEqual([]);
    expect(manifest.baselineNotes?.[0]).toMatch(/Pre-existing test failure/);
    expect(manifest.baselineNotes?.[0]).toMatch(/example\.com\/fixture\/broken/);
    expect(manifest.gates?.baseline?.status).toBe("pre-existing");
    expect(manifest.gates?.baseline?.packages).toEqual(["example.com/fixture/broken"]);
  }, 60_000);

  it("keeps the blocker, annotated, when the run's own change broke a package it never directly touched", async () => {
    const dir = writeSharedDependencyFixture();
    const before = await captureGitSnapshot(dir);
    // Break `broken` indirectly by editing `shared` (not `broken/` itself).
    touchAndCommit(dir, "shared/shared.go", "package shared\n\nfunc Flag() bool { return false }\n");

    const manifest = await buildFinalManifest({
      workspace: dir,
      beforeGitSnapshot: before,
      changed: ["shared/shared.go"],
      verificationLines: ["Verification: go test ./... -> failed (Command exited 1.)"],
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      blockers: [ORIGINAL_BLOCKER],
      interactive: false,
    });

    expect(manifest.blockers).toHaveLength(1);
    expect(manifest.blockers[0]).toMatch(/introduced by this run/);
    expect(manifest.baselineNotes ?? []).toEqual([]);
    expect(manifest.gates?.baseline?.status).toBe("introduced");
  }, 60_000);

  it("never reclassifies when a failing package intersects the touched set", async () => {
    const dir = writeBrokenAtBaseFixture();
    const before = await captureGitSnapshot(dir);
    touchAndCommit(dir, "broken/broken.go", "package broken\n\n// touched, still broken\nfunc AlwaysTrue() bool { return false }\n");

    const manifest = await buildFinalManifest({
      workspace: dir,
      beforeGitSnapshot: before,
      changed: ["broken/broken.go"],
      verificationLines: [`Verification: go test ./... -> failed (Command exited 1.)`],
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      blockers: [ORIGINAL_BLOCKER],
      interactive: false,
    });

    // Untouched (unchanged), no annotation, no removal — the run touched the
    // failing package, so it stays fully responsible.
    expect(manifest.blockers).toEqual([ORIGINAL_BLOCKER]);
    expect(manifest.gates?.baseline).toBeUndefined();
  }, 60_000);

  it("is inconclusive (keeps the blocker) when the baseline commit cannot be checked out", async () => {
    const dir = writeBrokenAtBaseFixture();
    const before = await captureGitSnapshot(dir);
    touchAndCommit(dir, "good/good.go", "package good\n\n// touched\nfunc Add(a, b int) int { return a + b }\n");

    if (!before) throw new Error("expected a git snapshot for the fixture repo");
    const manifest = await buildFinalManifest({
      workspace: dir,
      // A syntactically-valid but nonexistent commit — the worktree add fails.
      beforeGitSnapshot: { ...before, head: "0000000000000000000000000000000000000000" },
      changed: ["good/good.go"],
      verificationLines: [`Verification: go test ./... -> failed (Command exited 1.)`],
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      blockers: [ORIGINAL_BLOCKER],
      interactive: false,
    });

    expect(manifest.blockers).toEqual([ORIGINAL_BLOCKER]);
    expect(manifest.gates?.baseline).toBeUndefined();
  }, 60_000);

  it("keeps the blocker unchanged when there is no session base commit to compare against", async () => {
    const dir = writeBrokenAtBaseFixture();
    touchAndCommit(dir, "good/good.go", "package good\n\n// touched\nfunc Add(a, b int) int { return a + b }\n");

    const manifest = await buildFinalManifest({
      workspace: dir,
      beforeGitSnapshot: null,
      changed: ["good/good.go"],
      verificationLines: [`Verification: go test ./... -> failed (Command exited 1.)`],
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      blockers: [ORIGINAL_BLOCKER],
      interactive: false,
    });

    expect(manifest.blockers).toEqual([ORIGINAL_BLOCKER]);
  }, 60_000);
});
