import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ExternalExecutor, ExecutorId, ExecutorResult } from "../../executors/types";

// ── helpers ────────────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tanya-externalRun-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "app.txt"), "one\n");
  git(dir, ["add", "app.txt"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function noopSink(): void {}

// Fake executor that commits its work.
function committingExecutor(): ExternalExecutor {
  return {
    id: "claude",
    binary: "fake-claude",
    available: vi.fn().mockResolvedValue(true),
    run: vi.fn().mockImplementation(async (task) => {
      writeFileSync(join(task.cwd, "created.txt"), "hello\n");
      git(task.cwd, ["add", "created.txt"]);
      git(task.cwd, ["commit", "-m", "fake: created"]);
      return {
        ok: true,
        exitCode: 0,
        transcript: "Wrote created.txt\nCommitted.\n",
        finalText: "Done — created.txt committed.",
      };
    }),
  } as unknown as ExternalExecutor;
}

// Fake executor that creates a file but does NOT commit.
function uncommittedExecutor(): ExternalExecutor {
  return {
    id: "claude",
    binary: "fake-claude",
    available: vi.fn().mockResolvedValue(true),
    run: vi.fn().mockImplementation(async (task) => {
      writeFileSync(join(task.cwd, "new.txt"), "secret\n");
      return {
        ok: true,
        exitCode: 0,
        transcript: "Wrote new.txt\n",
        finalText: "Done.",
      };
    }),
  } as unknown as ExternalExecutor;
}

// Fake executor that reports auth expired.
function authExpiredExecutor(): ExternalExecutor {
  return {
    id: "claude",
    binary: "fake-claude",
    available: vi.fn().mockResolvedValue(true),
    run: vi.fn().mockResolvedValue({
      ok: false,
      exitCode: 1,
      transcript: "Authentication expired. Please run `claude login` again.\n",
      finalText: "auth expired",
      authExpired: true,
    } satisfies ExecutorResult),
  } as unknown as ExternalExecutor;
}

function mockExecutorModule(fake: ExternalExecutor) {
  const mockResolve = vi.fn().mockReturnValue(fake);
  const mockList = vi.fn().mockResolvedValue([
    { id: "claude" as ExecutorId, available: true },
    { id: "codex" as ExecutorId, available: false },
  ]);

  vi.doMock("../../executors/index", () => ({
    resolveExecutor: mockResolve,
    listExecutors: mockList,
  }));

  return { mockResolve, mockList };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("ExternalBackend — tanya run --backend", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unmock("../../executors/index");
  });

  // (a) fake backend commits its work → PASSED, diff in changedFiles, backend in manifest
  it("(a) fake backend commits its work → PASSED with diff and backend recorded", async () => {
    const repo = makeRepo();
    const { mockResolve, mockList } = mockExecutorModule(committingExecutor());

    const { runWithExternalBackend } = await import("../externalRun");
    const result = await runWithExternalBackend({
      backend: "claude",
      prompt: "Create created.txt and commit it.",
      cwd: repo,
      sink: noopSink,
    });

    expect(mockResolve).toHaveBeenCalledWith("claude");
    expect(mockList).not.toHaveBeenCalled(); // executor was found

    // PASSED — no blockers
    expect(result.manifest.blockers).toEqual([]);

    // created.txt in changedFiles
    expect(result.manifest.changedFiles).toContain("created.txt");

    // backend field recorded
    expect((result.manifest as Record<string, unknown>).backend).toBe("claude");

    // Verify the commit really exists in the repo
    expect(gitOut(repo, ["log", "--oneline"])).toContain("created");
  }, 20_000);

  // (a2) memory side-effects: an external run finalize records task history
  // and (when the golden flag is set) golden-task memory — the same tail the
  // native runner runs. External runs used to skip all of this silently.
  it("(a2) external run records task history and golden-task memory", async () => {
    const repo = makeRepo();
    mockExecutorModule(committingExecutor());

    const { runWithExternalBackend } = await import("../externalRun");
    const result = await runWithExternalBackend({
      backend: "claude",
      prompt: "Create created.txt and commit it.",
      cwd: repo,
      sink: noopSink,
      runContext: { metadata: { goldenTask: true } },
    });
    expect(result.manifest.blockers).toEqual([]);

    const history = JSON.parse(readFileSync(join(repo, ".tanya", "history.json"), "utf8")) as unknown[];
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBe(1);

    const golden = readFileSync(join(repo, ".tanya", "memory", "golden-tasks.jsonl"), "utf8");
    expect(golden).toContain('"outcome":"passed"');

    // The archive uses the unified writer: top-level verdict/blockers/
    // changedFiles so the doctor's RunArchive reader sees external runs too
    // (the old external writer nested everything under `manifest`).
    expect(result.manifest.runId).toBeTruthy();
    const archivePath = join(repo, ".tanya", "runs", `${result.manifest.runId}.json`);
    const parsed = JSON.parse(readFileSync(archivePath, "utf8")) as Record<string, unknown>;
    expect(parsed.verdict).toBe("PASSED");
    expect(parsed.backend).toBe("claude");
    expect(parsed.provider).toBe("external:claude");
    expect(parsed.changedFiles).toContain("created.txt");
  }, 20_000);

  // (b) fake leaves work uncommitted + prompt says commit → commit gate FAILs
  it("(b) fake leaves work uncommitted + prompt says commit → commit gate FAILs", async () => {
    const repo = makeRepo();
    mockExecutorModule(uncommittedExecutor());

    const { runWithExternalBackend } = await import("../externalRun");
    const result = await runWithExternalBackend({
      backend: "claude",
      prompt: "Create new.txt. Commit path-limited at the end.",
      cwd: repo,
      sink: noopSink,
    });

    // Commit gate should have armed — blocker present
    const hasCommitBlocker = result.manifest.blockers.some(
      (b) => /commit incomplete/i.test(b) || /requires a git commit/i.test(b),
    );
    expect(hasCommitBlocker).toBe(true);

    // File was created but not committed
    expect(gitOut(repo, ["status", "--porcelain"])).toContain("new.txt");
  }, 20_000);

  // (c) fake reports auth-expired → blocker names the re-login command
  it("(c) fake reports auth-expired → blocker names the re-login command", async () => {
    const repo = makeRepo();
    mockExecutorModule(authExpiredExecutor());

    const { runWithExternalBackend } = await import("../externalRun");
    const result = await runWithExternalBackend({
      backend: "claude",
      prompt: "Do something.",
      cwd: repo,
      sink: noopSink,
    });

    // Message should reference the re-login command
    expect(result.message).toContain("auth expired");
    expect(result.message).toContain("claude login");

    // Blocker present
    expect(result.manifest.blockers.some((b) => /auth expired/i.test(b))).toBe(true);

    // No crash — result returned cleanly
    expect(result.manifest.schemaVersion).toBe(1);
  }, 20_000);

  // (d) unknown/unavailable backend → clean error, no crash
  it("(d) unknown backend → clean error, no crash", async () => {
    const repo = makeRepo();

    // Register only claude — "unknown-bot" won't resolve
    const fakeClaude = committingExecutor();
    const mockResolve = vi.fn().mockReturnValue(undefined); // resolve fails
    const mockList = vi.fn().mockResolvedValue([
      { id: "claude" as ExecutorId, available: true },
    ]);
    vi.doMock("../../executors/index", () => ({
      resolveExecutor: mockResolve,
      listExecutors: mockList,
    }));

    const { runWithExternalBackend } = await import("../externalRun");
    const result = await runWithExternalBackend({
      backend: "unknown-bot" as ExecutorId,
      prompt: "Do something.",
      cwd: repo,
      sink: noopSink,
    });

    // Clean error — no crash
    expect(result.manifest.blockers.some((b) => /unknown backend/i.test(b))).toBe(true);
    expect(result.message).toContain("unknown");
    // listExecutors was called so the message shows available backends
    expect(mockList).toHaveBeenCalled();
  }, 20_000);

  // (d-alt) available resolver but executor reports unavailable → clean error
  it("(d-alt) executor found but unavailable → clean error with re-login hint", async () => {
    const repo = makeRepo();
    const fakeUnavailable: ExternalExecutor = {
      id: "claude",
      binary: "fake-claude",
      available: vi.fn().mockResolvedValue(false),
      run: vi.fn(),
    } as unknown as ExternalExecutor;

    const mockResolve = vi.fn().mockReturnValue(fakeUnavailable);
    const mockList = vi.fn().mockResolvedValue([
      { id: "claude" as ExecutorId, available: false },
    ]);
    vi.doMock("../../executors/index", () => ({
      resolveExecutor: mockResolve,
      listExecutors: mockList,
    }));

    const { runWithExternalBackend } = await import("../externalRun");
    const result = await runWithExternalBackend({
      backend: "claude",
      prompt: "Do something.",
      cwd: repo,
      sink: noopSink,
    });

    expect(result.manifest.blockers.some((b) => /unavailable backend/i.test(b))).toBe(true);
    expect(result.message).toContain("not available");
    expect(fakeUnavailable.run).not.toHaveBeenCalled();
  }, 20_000);

  // (f) PROMPT B3: the external-backend path was the one entrypoint with no
  // exit sentinel — a kill -9 while the external CLI ground away left no
  // trace. The heartbeat must exist while the backend runs and be cleaned
  // once the real archive lands.
  it("(f) heartbeat exists while the backend runs and is cleaned after the archive lands", async () => {
    const repo = makeRepo();
    let heartbeatDuringRun = false;
    const fake = {
      id: "claude",
      binary: "fake-claude",
      available: vi.fn().mockResolvedValue(true),
      run: vi.fn().mockImplementation(async (task: { cwd: string }) => {
        heartbeatDuringRun = existsSync(join(task.cwd, ".tanya", "RUN_IN_PROGRESS.md"));
        writeFileSync(join(task.cwd, "created.txt"), "hello\n");
        git(task.cwd, ["add", "created.txt"]);
        git(task.cwd, ["commit", "-q", "-m", "fake: created"]);
        return { ok: true, exitCode: 0, transcript: "done\n", finalText: "Done." };
      }),
    } as unknown as ExternalExecutor;
    mockExecutorModule(fake);

    const { runWithExternalBackend } = await import("../externalRun");
    await runWithExternalBackend({ backend: "claude", prompt: "create created.txt", cwd: repo, sink: noopSink });

    expect(heartbeatDuringRun).toBe(true);
    expect(existsSync(join(repo, ".tanya", "RUN_IN_PROGRESS.md"))).toBe(false);
  });
});
