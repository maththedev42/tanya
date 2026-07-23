import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stringFlag } from "../config/runtimeFlags";

// Turn snapshots (CodeWhale port): a side git repository per snapshotted root
// under ~/.tanya/snapshots/<hash>, driven exclusively with --git-dir +
// --work-tree so the user's own .git is NEVER touched. Snapshots are
// parentless marker commits tracked as refs under refs/tanya/, so pruning is
// ref deletion, not history rewriting. Works in non-git directories too.
//
// Tanya twist vs CodeWhale: the serve workspace is often a FOLDER OF git
// repos; `git add -A` at that root records nested repos as gitlinks without
// their contents. Snapshots therefore key on the OWNING REPO ROOT of the
// paths a mutating tool is about to touch (snapshotForPaths), not the
// workspace root.
//
// Every failure is non-fatal by contract: a snapshot must never break a run.

export interface SnapshotRecord {
  id: string;
  label: string;
  sha: string;
  epochMs: number;
}

const SNAPSHOT_CAP = 50;
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function snapshotsRootDir(): string {
  const override = stringFlag("TANYA_SNAPSHOTS_DIR");
  return override || join(homedir(), ".tanya", "snapshots");
}

/** Canonical form of a root: symlinks resolved (macOS /var vs /private/var),
 *  so the same directory always maps to the same side repo. */
function canonicalRoot(root: string): string {
  try {
    return realpathSync(resolve(root));
  } catch {
    return resolve(root);
  }
}

function sideRepoDirFor(root: string): string {
  const hash = createHash("sha256").update(canonicalRoot(root)).digest("hex").slice(0, 16);
  return join(snapshotsRootDir(), hash);
}

function git(gitDir: string, workTree: string, args: string[], input?: string): string {
  // cwd MUST be the work tree: git resolves pathspecs (`add -A -- .`) against
  // the process cwd, not --work-tree.
  return execFileSync("git", [`--git-dir=${gitDir}`, `--work-tree=${workTree}`, ...args], {
    cwd: workTree,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // Keep git advice/warnings (e.g. embedded-repo hints on `add -A`) off the
    // user's terminal; failures still carry stderr on the thrown error.
    stdio: ["pipe", "pipe", "pipe"],
    ...(input !== undefined ? { input } : {}),
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "tanya-snapshots",
      GIT_AUTHOR_EMAIL: "snapshots@tanya.local",
      GIT_COMMITTER_NAME: "tanya-snapshots",
      GIT_COMMITTER_EMAIL: "snapshots@tanya.local",
    },
  });
}

/** Whether `root` already has a side repo. Read paths (list/undo/restore)
 *  check this first: creating a store — and worse, `add -A`-ing the whole
 *  tree into its object db — just to answer "nothing here" litters
 *  ~/.tanya/snapshots with stores for directories that were never snapshotted. */
function sideRepoExists(root: string): boolean {
  return existsSync(join(sideRepoDirFor(root), ".git"));
}

function ensureSideRepo(root: string): { gitDir: string; workTree: string } | null {
  try {
    const workTree = canonicalRoot(root);
    const gitDir = join(sideRepoDirFor(workTree), ".git");
    if (!existsSync(gitDir)) {
      mkdirSync(dirname(gitDir), { recursive: true });
      // `git --git-dir=X init` creates the repository directory directly with
      // no recorded worktree — every later call passes --git-dir and
      // --work-tree explicitly.
      execFileSync("git", [`--git-dir=${gitDir}`, "init", "--quiet"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      git(gitDir, workTree, ["config", "gc.auto", "0"]);
    }
    return { gitDir, workTree };
  } catch {
    return null;
  }
}

function slugify(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "snapshot";
}

/** Take one snapshot of `root` (marker commit even when the tree is
 *  unchanged). Returns null on any failure — snapshots never break a run. */
export function takeSnapshot(root: string, label: string): SnapshotRecord | null {
  const repo = ensureSideRepo(root);
  if (!repo) return null;
  try {
    git(repo.gitDir, repo.workTree, ["add", "-A", "--", "."]);
    const treeSha = git(repo.gitDir, repo.workTree, ["write-tree"]).trim();
    const sha = git(repo.gitDir, repo.workTree, ["commit-tree", treeSha, "-m", label]).trim();
    const epochMs = Date.now();
    const id = `s${epochMs}-${slugify(label)}`;
    git(repo.gitDir, repo.workTree, ["update-ref", `refs/tanya/${id}`, sha]);
    pruneSnapshots(root);
    return { id, label, sha, epochMs };
  } catch {
    return null;
  }
}

/** List snapshots for `root`, newest first. */
export function listSnapshots(root: string): SnapshotRecord[] {
  if (!sideRepoExists(root)) return [];
  const repo = ensureSideRepo(root);
  if (!repo) return [];
  try {
    const output = git(repo.gitDir, repo.workTree, [
      "for-each-ref",
      "--format=%(refname:short)\t%(objectname)\t%(contents:subject)",
      "refs/tanya/",
    ]);
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref = "", sha = "", ...subject] = line.split("\t");
        const id = ref.replace(/^tanya\//, "");
        const epochMs = Number(id.match(/^s(\d+)-/)?.[1] ?? 0);
        return { id, sha, label: subject.join("\t"), epochMs };
      })
      .filter((record) => record.id && record.sha)
      .sort((a, b) => b.epochMs - a.epochMs);
  } catch {
    return [];
  }
}

/** Cap + age-prune the snapshot refs; occasionally drop unreachable objects. */
export function pruneSnapshots(root: string): void {
  if (!sideRepoExists(root)) return;
  const repo = ensureSideRepo(root);
  if (!repo) return;
  try {
    const all = listSnapshots(root);
    const cutoff = Date.now() - SNAPSHOT_MAX_AGE_MS;
    const evict = [
      ...all.slice(SNAPSHOT_CAP),
      ...all.slice(0, SNAPSHOT_CAP).filter((record) => record.epochMs > 0 && record.epochMs < cutoff),
    ];
    for (const record of evict) {
      try {
        git(repo.gitDir, repo.workTree, ["update-ref", "-d", `refs/tanya/${record.id}`]);
      } catch {
        // Best-effort per ref.
      }
    }
    if (evict.length > 0) {
      git(repo.gitDir, repo.workTree, ["prune", "--expire=now"]);
    }
  } catch {
    // Pruning must never fail the caller.
  }
}

function treeFiles(repo: { gitDir: string; workTree: string }, sha: string): string[] {
  return git(repo.gitDir, repo.workTree, ["ls-tree", "-r", "--name-only", sha])
    .split("\n")
    .filter(Boolean);
}

/** Restore `root` to a snapshot: write the target tree over the worktree and
 *  delete files that exist now but not in the target. Takes a `pre-restore`
 *  snapshot first so a restore is itself undoable. Returns false on failure. */
export function restoreSnapshot(root: string, id: string): boolean {
  if (!sideRepoExists(root)) return false;
  const repo = ensureSideRepo(root);
  if (!repo) return false;
  try {
    const target = listSnapshots(root).find((record) => record.id === id);
    if (!target) return false;
    const pre = takeSnapshot(root, "pre-restore");
    if (!pre) return false;
    const nowFiles = treeFiles(repo, pre.sha);
    const targetFiles = new Set(treeFiles(repo, target.sha));
    git(repo.gitDir, repo.workTree, ["read-tree", target.sha]);
    git(repo.gitDir, repo.workTree, ["checkout-index", "-a", "-f"]);
    for (const file of nowFiles) {
      if (targetFiles.has(file)) continue;
      try {
        rmSync(join(repo.workTree, file), { force: true });
      } catch {
        // Best-effort per file.
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Undo: restore to the newest snapshot whose tree DIFFERS from the current
 *  worktree (so repeated undo keeps walking backward instead of no-opping).
 *  Returns the restored snapshot, or null when there is nothing to undo. */
export function undoToPreviousSnapshot(root: string): SnapshotRecord | null {
  if (!sideRepoExists(root)) return null;
  const repo = ensureSideRepo(root);
  if (!repo) return null;
  try {
    git(repo.gitDir, repo.workTree, ["add", "-A", "--", "."]);
    const currentTree = git(repo.gitDir, repo.workTree, ["write-tree"]).trim();
    for (const record of listSnapshots(root)) {
      if (record.label === "pre-restore") continue;
      const tree = git(repo.gitDir, repo.workTree, ["rev-parse", `${record.sha}^{tree}`]).trim();
      if (tree === currentTree) continue;
      return restoreSnapshot(root, record.id) ? record : null;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Owning-repo resolution for mutating tool calls ──────────────────────────

const repoRootCache = new Map<string, string>();

/** The git repo root that owns `path` (falling back to the workspace for
 *  non-git locations). Cached per directory. */
export function owningRoot(workspace: string, relativeOrAbsolutePath: string): string {
  const absolute = resolve(workspace, relativeOrAbsolutePath);
  let dir = absolute;
  try {
    if (!statSync(absolute).isDirectory()) dir = dirname(absolute);
  } catch {
    dir = dirname(absolute);
  }
  const probeDir = existsSync(dir) ? dir : workspace;
  const cached = repoRootCache.get(probeDir);
  if (cached) return cached;
  let root = resolve(workspace);
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: probeDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || root;
  } catch {
    // Not inside a git repo — snapshot the workspace itself.
  }
  repoRootCache.set(probeDir, root);
  return root;
}

/** Snapshot every repo root about to be touched by a mutating tool call.
 *  Dedupes roots; failures are silently ignored (non-fatal by contract). */
export function snapshotForPaths(workspace: string, paths: string[], label: string): SnapshotRecord[] {
  const roots = new Set<string>();
  if (paths.length === 0) roots.add(resolve(workspace));
  for (const path of paths) roots.add(owningRoot(workspace, path));
  const records: SnapshotRecord[] = [];
  for (const root of roots) {
    const record = takeSnapshot(root, label);
    if (record) records.push(record);
  }
  return records;
}
