import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createTaskWorktree,
  isGitRepo,
  readTaskMeta,
  taskDiff,
  taskDiscard,
  taskMerge,
} from "../worktree";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tanya-worktree-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@tanya.local"]);
  git(dir, ["config", "user.name", "Tanya Test"]);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

function commitInWorktree(worktreePath: string, file: string, content: string, message: string): void {
  writeFileSync(join(worktreePath, file), content);
  git(worktreePath, ["config", "user.email", "test@tanya.local"]);
  git(worktreePath, ["config", "user.name", "Tanya Test"]);
  git(worktreePath, ["add", file]);
  git(worktreePath, ["commit", "-q", "-m", message]);
}

describe("worktree task sessions", () => {
  let repo: string;
  beforeEach(() => {
    repo = initRepo();
  });

  it("detects git repos", async () => {
    await expect(isGitRepo(repo)).resolves.toBe(true);
    await expect(isGitRepo(mkdtempSync(join(tmpdir(), "tanya-nogit-")))).resolves.toBe(false);
  });

  it("creates an isolated worktree, branch, and task metadata", async () => {
    const meta = await createTaskWorktree(repo, "abc123");
    expect(meta.branch).toBe("tanya/task-abc123");
    expect(meta.originBranch).toBe("main");
    expect(existsSync(meta.worktreePath)).toBe(true);
    expect(existsSync(join(meta.worktreePath, "README.md"))).toBe(true);
    // Persisted metadata is what the /task-* commands read back from cwd.
    // (mainRoot is git's canonical path — /private-resolved on macOS.)
    expect(readTaskMeta(meta.worktreePath)).toMatchObject({ branch: "tanya/task-abc123", mainRoot: meta.mainRoot });
    // The branch exists and the main tree is untouched (worktree lives in .git).
    expect(git(repo, ["branch", "--list", "tanya/task-abc123"])).toContain("tanya/task-abc123");
    expect(git(repo, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("shows the worktree's changes in the diff", async () => {
    const meta = await createTaskWorktree(repo, "diff1");
    writeFileSync(join(meta.worktreePath, "feature.ts"), "export const x = 1;\n");
    const diff = await taskDiff(meta);
    expect(diff).toContain("tanya/task-diff1");
    expect(diff).toContain("feature.ts");
  });

  it("squash-merges a committed task into the origin branch and cleans up", async () => {
    const meta = await createTaskWorktree(repo, "merge1");
    commitInWorktree(meta.worktreePath, "feature.ts", "export const x = 1;\n", "add feature");

    const result = await taskMerge(meta);
    expect(result.ok).toBe(true);
    // Landed on main.
    expect(existsSync(join(repo, "feature.ts"))).toBe(true);
    expect(git(repo, ["log", "--format=%s", "-1"]).trim()).toBe("add feature");
    // Worktree and branch are gone.
    expect(existsSync(meta.worktreePath)).toBe(false);
    expect(git(repo, ["branch", "--list", "tanya/task-merge1"]).trim()).toBe("");
  });

  it("refuses to merge a dirty worktree", async () => {
    const meta = await createTaskWorktree(repo, "dirty1");
    writeFileSync(join(meta.worktreePath, "feature.ts"), "uncommitted\n");
    const result = await taskMerge(meta);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("uncommitted changes");
    // Nothing landed; worktree still present.
    expect(existsSync(join(repo, "feature.ts"))).toBe(false);
    expect(existsSync(meta.worktreePath)).toBe(true);
  });

  it("discards a task without landing its changes", async () => {
    const meta = await createTaskWorktree(repo, "discard1");
    commitInWorktree(meta.worktreePath, "feature.ts", "export const x = 1;\n", "add feature");

    const message = await taskDiscard(meta);
    expect(message).toContain("Discarded");
    expect(existsSync(join(repo, "feature.ts"))).toBe(false);
    expect(existsSync(meta.worktreePath)).toBe(false);
    expect(git(repo, ["branch", "--list", "tanya/task-discard1"]).trim()).toBe("");
  });

  it("returns null metadata for a non-task directory", () => {
    expect(readTaskMeta(repo)).toBeNull();
  });

  it("reports nothing-to-merge for a task with no new commits", async () => {
    const meta = await createTaskWorktree(repo, "empty1");
    const result = await taskMerge(meta);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no commits");
  });
});

describe("task metadata round-trip", () => {
  it("survives a JSON read from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "tanya-meta-"));
    const metaDir = join(dir, ".tanya");
    execFileSync("mkdir", ["-p", metaDir]);
    writeFileSync(
      join(metaDir, "task.json"),
      JSON.stringify({ branch: "tanya/task-x", base: "abc", mainRoot: "/repo", originBranch: "main", worktreePath: "/wt" }),
    );
    expect(readTaskMeta(dir)?.branch).toBe("tanya/task-x");
    // A malformed file reads back as null, not a throw.
    writeFileSync(join(metaDir, "task.json"), "{ not json");
    expect(readTaskMeta(dir)).toBeNull();
    expect(readFileSync(join(metaDir, "task.json"), "utf8")).toContain("not json");
  });
});
