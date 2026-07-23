import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureGitSnapshot, sessionUncommittedFiles } from "../git";
import { buildFinalManifest } from "../report";
import type { TanyaRunContext } from "../../context/runContext";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function write(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function makeRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "tanya-commitcomplete-"));
  initRepo(dir);
  write(dir, "README.md", "seed\n");
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

const rc = (v: unknown): TanyaRunContext => v as TanyaRunContext;

function baseParams(dir: string, changed: string[], before: Awaited<ReturnType<typeof captureGitSnapshot>>) {
  return {
    workspace: dir,
    beforeGitSnapshot: before,
    changed,
    verificationLines: [],
    toolErrorCount: 0,
    readArtifactPaths: [],
    readContextPaths: [],
    createdArtifactPaths: [],
  };
}

describe("sessionUncommittedFiles (F2 — broken committed tree)", () => {
  it("flags a session-written file left untracked", async () => {
    const dir = makeRepo();
    write(dir, "GettingStartedManager.swift", "class GettingStartedManager {}\n"); // untracked
    const result = await sessionUncommittedFiles(dir, ["GettingStartedManager.swift"]);
    expect(result).toHaveLength(1);
    expect(result[0]?.files).toContain("GettingStartedManager.swift");
  });

  it("passes when the session-written file was committed", async () => {
    const dir = makeRepo();
    write(dir, "View.swift", "struct View {}\n");
    git(dir, ["add", "View.swift"]);
    git(dir, ["commit", "-q", "-m", "add view"]);
    expect(await sessionUncommittedFiles(dir, ["View.swift"])).toEqual([]);
  });

  it("ignores dirty files the session did NOT write", async () => {
    const dir = makeRepo();
    write(dir, "unrelated.txt", "someone else edited this\n"); // dirty, but not in writeLog
    write(dir, "mine.swift", "struct Mine {}\n");
    git(dir, ["add", "mine.swift"]);
    git(dir, ["commit", "-q", "-m", "mine"]);
    expect(await sessionUncommittedFiles(dir, ["mine.swift"])).toEqual([]);
  });

  it("covers a NESTED repo under the workspace (multi-repo)", async () => {
    const parent = makeRepo();
    const nested = join(parent, "sub");
    mkdirSync(nested, { recursive: true });
    initRepo(nested);
    write(nested, "seed.txt", "x\n");
    git(nested, ["add", "-A"]);
    git(nested, ["commit", "-q", "-m", "init nested"]);
    write(nested, "leftover.go", "package sub\n"); // untracked in the NESTED repo
    const result = await sessionUncommittedFiles(parent, ["sub/leftover.go"]);
    expect(result).toHaveLength(1);
    expect(result[0]?.repoRoot.endsWith("/sub")).toBe(true);
    expect(result[0]?.files).toContain("leftover.go");
  });
});

describe("commit-completeness gate in buildFinalManifest", () => {
  it("F2 shape: commits the View, leaves the Manager untracked → blocker names the Manager", async () => {
    const dir = makeRepo();
    const before = await captureGitSnapshot(dir);
    // Session writes both; commits only the View (which references the Manager).
    write(dir, "GettingStartedView.swift", "let m = GettingStartedManager.shared\n");
    write(dir, "GettingStartedManager.swift", "class GettingStartedManager { static let shared = 1 }\n");
    git(dir, ["add", "GettingStartedView.swift"]);
    git(dir, ["commit", "-q", "-m", "add getting started view"]);

    const manifest = await buildFinalManifest({
      ...baseParams(dir, ["GettingStartedView.swift", "GettingStartedManager.swift"], before),
      interactive: false,
    });

    expect(manifest.blockers.some((b) => /Commit incomplete/i.test(b))).toBe(true);
    expect(manifest.blockers.some((b) => b.includes("GettingStartedManager.swift"))).toBe(true);
    expect(manifest.uncommittedSessionFiles?.[0]?.files).toContain("GettingStartedManager.swift");
  });

  it("does NOT fire for a bare interactive chat turn (no task shape, no coding context)", async () => {
    const dir = makeRepo();
    const before = await captureGitSnapshot(dir);
    write(dir, "loose.swift", "struct Loose {}\n"); // untracked, session-written
    const manifest = await buildFinalManifest({
      ...baseParams(dir, ["loose.swift"], before),
      interactive: true,
    });
    expect(manifest.blockers.some((b) => /Commit incomplete/i.test(b))).toBe(false);
    expect(manifest.uncommittedSessionFiles).toBeUndefined();
  });

  it("E1: FIRES for an interactive TASK-SHAPED run that left a file untracked (mac-app hole)", async () => {
    const dir = makeRepo();
    const before = await captureGitSnapshot(dir);
    write(dir, "GettingStartedManager.swift", "class GettingStartedManager {}\n"); // untracked
    const manifest = await buildFinalManifest({
      ...baseParams(dir, ["GettingStartedManager.swift"], before),
      interactive: true, // mac app runs everything interactive
      prompt: "# FIX-01\n\n## Part 1\nDo the manager.\n\n## Part 2\nWire it.\n\n## Verify\nRun `xcodebuild build`.",
    });
    expect(manifest.blockers.some((b) => /Commit incomplete/i.test(b))).toBe(true);
    expect(manifest.blockers.some((b) => b.includes("GettingStartedManager.swift"))).toBe(true);
  });

  it("E1: FIRES for an interactive coding run that changed files and left them uncommitted", async () => {
    const dir = makeRepo();
    const before = await captureGitSnapshot(dir);
    write(dir, "loose.swift", "struct Loose {}\n"); // untracked, session-written
    const manifest = await buildFinalManifest({
      ...baseParams(dir, ["loose.swift"], before),
      interactive: true,
      runContext: rc({ task: { kind: "coding", title: "add loose" } }),
      prompt: "add a Loose struct",
    });
    expect(manifest.blockers.some((b) => /Commit incomplete/i.test(b))).toBe(true);
  });

  it("respects TANYA_TASK_GATES=off for interactive task runs", async () => {
    const dir = makeRepo();
    const before = await captureGitSnapshot(dir);
    write(dir, "loose.swift", "struct Loose {}\n");
    const prev = process.env.TANYA_TASK_GATES;
    process.env.TANYA_TASK_GATES = "off";
    try {
      const manifest = await buildFinalManifest({
        ...baseParams(dir, ["loose.swift"], before),
        interactive: true,
        runContext: rc({ task: { kind: "coding", title: "x" } }),
        prompt: "## Part 1\nx\n## Part 2\ny",
      });
      expect(manifest.blockers.some((b) => /Commit incomplete/i.test(b))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.TANYA_TASK_GATES;
      else process.env.TANYA_TASK_GATES = prev;
    }
  });

  it("does NOT fire for a pipeline run that manages its own commits", async () => {
    const dir = makeRepo();
    const before = await captureGitSnapshot(dir);
    write(dir, "loose.swift", "struct Loose {}\n");
    const manifest = await buildFinalManifest({
      ...baseParams(dir, ["loose.swift"], before),
      runContext: rc({ metadata: {} }), // present but no requireCommit → opt-in off
      interactive: false,
    });
    expect(manifest.blockers.some((b) => /Commit incomplete/i.test(b))).toBe(false);
  });

  it("passes a clean run where everything written was committed", async () => {
    const dir = makeRepo();
    const before = await captureGitSnapshot(dir);
    write(dir, "done.swift", "struct Done {}\n");
    git(dir, ["add", "done.swift"]);
    git(dir, ["commit", "-q", "-m", "done"]);
    const manifest = await buildFinalManifest({
      ...baseParams(dir, ["done.swift"], before),
      interactive: false,
    });
    expect(manifest.blockers.some((b) => /Commit incomplete/i.test(b))).toBe(false);
  });
});
