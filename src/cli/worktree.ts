import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Everything a `/task-*` command needs to operate on a worktree task session,
 * persisted to `<worktree>/.tanya/task.json` at creation so the commands are
 * self-contained (they read it from their cwd) and survive a resume.
 */
export type TaskWorktreeMeta = {
  /** The isolated branch, e.g. `tanya/task-<id>`. */
  branch: string;
  /** Commit the worktree branched from (the merge/diff base). */
  base: string;
  /** Absolute path of the main repo's working tree. */
  mainRoot: string;
  /** Branch checked out in the main root when the task was created. */
  originBranch: string;
  /** Absolute path of the isolated worktree checkout. */
  worktreePath: string;
};

export const TASK_META_RELATIVE = join(".tanya", "task.json");

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function gitSafe(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch {
    return "";
  }
}

/**
 * `git status --porcelain` with Tanya's own runtime dir filtered out. The
 * worktree always carries an untracked `.tanya/` (task metadata, run logs),
 * which is never part of the task's code changes — counting it would make
 * every task look permanently dirty and block merges.
 */
function statusWithoutTanya(porcelain: string): string {
  return porcelain
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      const path = line.slice(3).replace(/^"|"$/g, "");
      return path !== ".tanya" && path !== ".tanya/" && !path.startsWith(".tanya/");
    })
    .join("\n");
}

async function worktreeStatus(cwd: string): Promise<string> {
  return statusWithoutTanya(await gitSafe(cwd, ["status", "--porcelain"]));
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Create an isolated worktree + branch for a task session. The worktree lives
 * under the shared git dir (`.git/tanya-worktrees/<id>`) so it never shows up
 * as untracked in the user's `git status` and needs no gitignore change.
 */
export async function createTaskWorktree(cwd: string, taskId: string): Promise<TaskWorktreeMeta> {
  const mainRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  const originBranch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const commonDirRaw = (await git(cwd, ["rev-parse", "--git-common-dir"])).trim();
  const gitCommonDir = resolve(cwd, commonDirRaw);

  const branch = `tanya/task-${taskId}`;
  const worktreePath = join(gitCommonDir, "tanya-worktrees", taskId);
  mkdirSync(dirname(worktreePath), { recursive: true });
  await git(mainRoot, ["worktree", "add", "-b", branch, worktreePath, base]);

  const meta: TaskWorktreeMeta = { branch, base, mainRoot, originBranch, worktreePath };
  mkdirSync(join(worktreePath, ".tanya"), { recursive: true });
  writeFileSync(join(worktreePath, TASK_META_RELATIVE), JSON.stringify(meta, null, 2));
  return meta;
}

export function readTaskMeta(cwd: string): TaskWorktreeMeta | null {
  const path = join(cwd, TASK_META_RELATIVE);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TaskWorktreeMeta>;
    if (typeof parsed.branch === "string" && typeof parsed.worktreePath === "string" &&
        typeof parsed.base === "string" && typeof parsed.mainRoot === "string") {
      return parsed as TaskWorktreeMeta;
    }
  } catch {
    // fall through to null
  }
  return null;
}

export async function taskDiff(meta: TaskWorktreeMeta): Promise<string> {
  const wt = meta.worktreePath;
  const diff = await gitSafe(wt, ["diff", meta.base]);
  const status = statusWithoutTanya(await gitSafe(wt, ["status", "--short"]));
  const lines = [`Task branch: ${meta.branch} (base ${meta.base.slice(0, 9)}, from ${meta.originBranch})`];
  if (status.trim()) lines.push("", "Working tree:", status.trimEnd());
  lines.push("", diff.trim() ? `Diff (base…worktree):\n${diff.trimEnd()}` : "No changes yet.");
  return lines.join("\n");
}

export type TaskMergeResult = { ok: true; message: string } | { ok: false; reason: string };

export async function taskMerge(meta: TaskWorktreeMeta): Promise<TaskMergeResult> {
  const wt = meta.worktreePath;
  if ((await worktreeStatus(wt)).trim()) {
    return { ok: false, reason: "The task worktree has uncommitted changes. Commit them on the task branch before merging." };
  }
  if ((await gitSafe(wt, ["rev-list", "--count", `${meta.base}..HEAD`])).trim() === "0") {
    return { ok: false, reason: "The task branch has no commits beyond its base — nothing to merge." };
  }
  if ((await worktreeStatus(meta.mainRoot)).trim()) {
    return { ok: false, reason: "The main working tree has uncommitted changes. Commit or stash them before merging a task." };
  }

  try {
    await git(meta.mainRoot, ["merge", "--squash", meta.branch]);
  } catch {
    // The main tree was clean, so a hard reset safely undoes the partial squash.
    const conflicts = (await gitSafe(meta.mainRoot, ["diff", "--name-only", "--diff-filter=U"])).trim();
    await gitSafe(meta.mainRoot, ["reset", "--hard"]);
    return { ok: false, reason: `Merge would conflict; nothing was applied. Conflicting files:\n${conflicts || "(unknown)"}` };
  }

  const subjects = (await gitSafe(wt, ["log", "--format=%s", `${meta.base}..HEAD`])).trim();
  const firstSubject = subjects.split("\n")[0] || `Merge ${meta.branch}`;
  const commitMessage = `${firstSubject}\n\nSquash-merged from ${meta.branch}:\n${subjects}`;
  try {
    await git(meta.mainRoot, ["commit", "-m", commitMessage]);
  } catch {
    // Squash staged nothing (task changes already present on the base) — undo.
    await gitSafe(meta.mainRoot, ["reset", "--hard"]);
    return { ok: false, reason: "Nothing to merge — the task's changes are already on the base branch." };
  }

  await cleanupWorktree(meta);
  return { ok: true, message: `Squash-merged ${meta.branch} into ${meta.originBranch} and removed the worktree.` };
}

export async function taskDiscard(meta: TaskWorktreeMeta): Promise<string> {
  await cleanupWorktree(meta);
  return `Discarded ${meta.branch} and removed the worktree at ${meta.worktreePath}.`;
}

async function cleanupWorktree(meta: TaskWorktreeMeta): Promise<void> {
  await gitSafe(meta.mainRoot, ["worktree", "remove", "--force", meta.worktreePath]);
  await gitSafe(meta.mainRoot, ["branch", "-D", meta.branch]);
}
