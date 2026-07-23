import type { TanyaRunContext } from "../context/runContext";
import type { TanyaFinalManifest } from "./runner";
import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitSnapshot = {
  repoRoot: string;
  head: string | null;
  files: string[];
};

export function normalizeGitPath(filePath: string): string {
  return filePath.trim().replace(/\\/g, "/").replace(/^"|"$/g, "");
}

export function isIgnoredReportPath(filePath: string): boolean {
  return filePath === ".." ||
    filePath.startsWith("../") ||
    /\.(?:orig|bak|backup|tmp)$/i.test(filePath) ||
    /(?:^|\/)DerivedData[^/]*(?:\/|$)/.test(filePath) ||
    /(?:^|\/)[^/]+\.xcresult(?:\/|$)/.test(filePath) ||
    /(?:^|\/)ModuleCache\.noindex(?:\/|$)/.test(filePath) ||
    /(?:^|\/)SDKStatCaches\.noindex(?:\/|$)/.test(filePath) ||
    /(?:^|\/)\.(?:tanya|cosmo)\//.test(filePath) ||
    filePath.startsWith(".git/") ||
    filePath.startsWith("node_modules/") ||
    filePath.startsWith(".next/") ||
    filePath.startsWith("dist/") ||
    filePath.startsWith("build/");
}

function parsePorcelainPath(line: string): string | null {
  if (line.length < 4) return null;
  const rawPath = line.slice(3).trim();
  if (!rawPath) return null;
  const renameTarget = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() : rawPath;
  return renameTarget ? normalizeGitPath(renameTarget) : null;
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export async function listFilesRecursive(root: string, current = root, maxDepth = 10, depth = 0, visited = new Set<string>()): Promise<string[]> {
  const files: string[] = [];
  if (depth > maxDepth) return files;
  let currentRealPath: string;
  try {
    currentRealPath = await realpath(current);
  } catch {
    return files;
  }
  if (visited.has(currentRealPath)) return files;
  visited.add(currentRealPath);
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = resolve(current, entry.name);
    if (entry.isDirectory()) {
      let fullRealPath: string;
      try {
        fullRealPath = await realpath(fullPath);
      } catch {
        continue;
      }
      if (visited.has(fullRealPath)) continue;
      files.push(...await listFilesRecursive(root, fullPath, maxDepth, depth + 1, visited));
    } else if (entry.isFile()) {
      files.push(normalizeGitPath(relative(root, fullPath)));
    }
  }
  return files;
}

export async function pathIsGitTracked(workspace: string, relPath: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", relPath], {
      cwd: workspace,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

export async function hasTrackedPathUnder(workspace: string, relPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", relPath], {
      cwd: workspace,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function captureGitSnapshot(workspace: string): Promise<GitSnapshot | null> {
  try {
    const { stdout: rootOut } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspace,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const repoRoot = rootOut.trim();
    const { stdout: statusOut } = await execFileAsync("git", ["status", "--porcelain=1"], {
      cwd: repoRoot,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    let head: string | null = null;
    try {
      const { stdout: headOut } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      });
      head = headOut.trim() || null;
    } catch {
      head = null;
    }
    const files: string[] = [];
    for (const filePath of statusOut
      .split(/\r?\n/)
      .map(parsePorcelainPath)
      .filter((pathValue): pathValue is string => !!pathValue && !isIgnoredReportPath(pathValue))) {
      const absolutePath = resolve(repoRoot, filePath);
      try {
        const fileStat = await stat(absolutePath);
        if (fileStat.isDirectory()) {
          const nestedFiles = await listFilesRecursive(absolutePath);
          files.push(...nestedFiles.map((nestedPath) => normalizeGitPath(`${filePath.replace(/\/$/, "")}/${nestedPath}`)));
          continue;
        }
      } catch {
        // Keep the original porcelain path as fallback evidence.
      }
      files.push(filePath);
    }
    return {
      repoRoot,
      head,
      files: uniqueSorted(files.filter((filePath) => filePath && !isIgnoredReportPath(filePath))),
    };
  } catch {
    return null;
  }
}

function toWorkspaceReportPath(filePath: string, snapshot: GitSnapshot, workspace: string): string | null {
  const absPath = resolve(snapshot.repoRoot, filePath);
  const relPath = normalizeGitPath(relative(workspace, absPath));
  if (!relPath || relPath === "." || relPath.startsWith("../") || relPath === "..") {
    return null;
  }
  return relPath;
}

export async function changedFilesFromGit(before: GitSnapshot | null, workspace: string): Promise<string[]> {
  const after = await captureGitSnapshot(workspace);
  if (!after) return [];
  const beforeFiles = new Set(before?.files ?? []);
  const changed = after.files.filter((filePath) => !beforeFiles.has(filePath));

  if (before?.head && after.head && before.head !== after.head) {
    try {
      const { stdout } = await execFileAsync("git", ["diff", "--name-only", before.head, after.head], {
        cwd: after.repoRoot,
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      });
      changed.push(
        ...stdout
          .split(/\r?\n/)
          .map(normalizeGitPath)
          .filter((filePath) => filePath && !isIgnoredReportPath(filePath)),
      );
    } catch {
      // The live tool-tracked file list still provides useful fallback evidence.
    }
  }

  return uniqueSorted(
    changed
      .map((filePath) => toWorkspaceReportPath(filePath, after, workspace))
      .filter((filePath): filePath is string => !!filePath && !isIgnoredReportPath(filePath)),
  );
}

export async function committedFilesFromGit(before: GitSnapshot | null, after: GitSnapshot | null, workspace: string): Promise<string[]> {
  if (!before?.head || !after?.head || before.head === after.head) return [];
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", before.head, after.head], {
      cwd: after.repoRoot,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return uniqueSorted(
      stdout
        .split(/\r?\n/)
        .map(normalizeGitPath)
        .filter((filePath) => filePath && !isIgnoredReportPath(filePath))
        .map((filePath) => toWorkspaceReportPath(filePath, after, workspace))
        .filter((filePath): filePath is string => !!filePath && !isIgnoredReportPath(filePath)),
    );
  } catch {
    return [];
  }
}

export function uncommittedFilesSince(before: GitSnapshot | null, after: GitSnapshot | null, workspace: string): string[] {
  if (!after) return [];
  const beforeFiles = new Set(before?.files ?? []);
  return normalizeReportPathsForWorkspace(
    after.files.filter((filePath) => !beforeFiles.has(filePath)),
    after,
    workspace,
  );
}

export function normalizeReportFiles(files: string[]): string[] {
  return uniqueSorted(files.map(normalizeGitPath).filter((filePath) => filePath && !isIgnoredReportPath(filePath)));
}

export function normalizeReportPathsForWorkspace(files: string[], snapshot: GitSnapshot | null, workspace: string): string[] {
  if (!snapshot) return normalizeReportFiles(files);
  const workspacePrefix = normalizeGitPath(relative(snapshot.repoRoot, workspace));
  if (!workspacePrefix || workspacePrefix === "." || workspacePrefix.startsWith("../") || workspacePrefix === "..") {
    return normalizeReportFiles(files);
  }
  return normalizeReportFiles(files.map((filePath) => {
    const normalized = normalizeGitPath(filePath);
    return normalized.startsWith(`${workspacePrefix}/`)
      ? normalized.slice(workspacePrefix.length + 1)
      : normalized;
  }));
}

function runContextBoolean(record: Record<string, unknown> | undefined, key: string): boolean {
  return record?.[key] === true;
}

function expectedReportIncludes(runContext: TanyaRunContext | undefined, key: string): boolean {
  const value = runContext?.expected_report?.[key];
  if (value === true) return true;
  if (Array.isArray(value)) return value.includes(key);
  if (typeof value === "string") return value.split(/[\s,]+/).includes(key);
  return false;
}

export function runContextRequiresCommit(runContext?: TanyaRunContext): boolean {
  return runContextBoolean(runContext?.metadata, "requireCommit") || expectedReportIncludes(runContext, "commit");
}

/**
 * Whether THIS run must commit its changes, given whether it changed files.
 *
 * - Ad-hoc CLI / interactive runs (no `runContext`) — the mode where users paste
 *   task prompts — require a commit BY DEFAULT once they change files. This is
 *   the arming fix: previously the gate was opt-in and thus permanently
 *   disarmed for exactly these runs. Explicit opt-out via
 *   `metadata.requireCommit === false` (programmatic callers) still wins.
 * - Pipeline runs (a `runContext` object IS present, e.g. the CosmoHQ V3 coding
 *   steps) keep the EXISTING opt-in semantics untouched — that pipeline manages
 *   its own worktree merges and must not have a commit forced on it.
 */
export function commitRequiredForRun(runContext: TanyaRunContext | undefined, hasChangedFiles: boolean): boolean {
  if (!hasChangedFiles) return false;
  if (runContext?.metadata?.requireCommit === false) return false;
  if (!runContext) return true;
  return runContextRequiresCommit(runContext);
}

// The prompt itself instructing a commit ("commit at the end", "commite
// path-limited"…) arms the commit gate even for pipeline runs whose runContext
// carries no commit flags — the audited FinanceWorld run's prompt said commit,
// the runContext didn't, so the gate stayed disarmed and the run shipped
// nothing committed with a green report. Negated mentions ("do not commit")
// are stripped first so a prompt that only FORBIDS committing never arms it.
// `metadata.requireCommit === false` (the documented programmatic opt-out for
// pipelines that manage git themselves) still wins — enforced at the arming
// site in report.ts.
const COMMIT_NEGATION = /\b(?:do\s+not|don'?t|never|no\s+need\s+to|without|skip(?:ping)?(?:\s+the)?|não|nunca|sem)\s+(?:commit(?:s|ted|ting)?|committing|commite|commitar)\b/gi;
const COMMIT_MENTION = /\bcommit(?:s|ted|ting|ar|e)?\b/i;

export function promptRequiresCommit(prompt: string): boolean {
  if (!prompt || !COMMIT_MENTION.test(prompt)) return false;
  return COMMIT_MENTION.test(prompt.replace(COMMIT_NEGATION, ""));
}

export function commitStillRequired(manifest: TanyaFinalManifest, beforeGitSnapshot: GitSnapshot | null, runContext?: TanyaRunContext): boolean {
  if (!commitRequiredForRun(runContext, manifest.changedFiles.length > 0)) return false;
  if (manifest.uncommittedFiles.length > 0) return true;
  if (!beforeGitSnapshot?.head || !manifest.git.head) return false;
  return manifest.git.head === beforeGitSnapshot.head.slice(0, 7);
}

/** The git repo root containing `absPath`, or null (not a repo / git unavailable). */
export async function repoRootForPath(absPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dirname(absPath),
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Distinct realpath'd git repo roots the given workspace-relative paths belong
 * to. Used to make a run's archive discoverable from every repo it touched: a
 * run driven from a workspace root (`--cwd Appzinhos`) archives under the
 * workspace, but an auditor looks in the touched repo's `.tanya/runs/` first.
 * One `git rev-parse` per distinct directory; best-effort (skips unresolvable
 * paths).
 */
export async function repoRootsForPaths(workspace: string, rels: Iterable<string>): Promise<string[]> {
  let realWorkspace = workspace;
  try {
    realWorkspace = await realpath(workspace);
  } catch {
    // Non-existent workspace: fall back to the given path.
  }
  const rootByDir = new Map<string, string | null>();
  const roots = new Set<string>();
  for (const rel of new Set(rels)) {
    if (!rel || isIgnoredReportPath(normalizeGitPath(rel))) continue;
    const abs = resolve(realWorkspace, rel);
    const dir = dirname(abs);
    let root = rootByDir.get(dir);
    if (root === undefined) {
      root = await repoRootForPath(abs);
      rootByDir.set(dir, root);
    }
    if (root) roots.add(root);
  }
  return uniqueSorted([...roots]);
}

/** Repo-root-relative paths that are dirty (untracked `??`, modified, or staged
 *  but not yet committed) in `repoRoot`, per `git status --porcelain`.
 *  `--untracked-files=all` is REQUIRED: without it git collapses an untracked
 *  NEW directory to `dir/` instead of listing `dir/file.swift`, so a file the
 *  run created in a fresh directory (the exact E1/E6 shape — a new source file
 *  under a new package dir) never matched the write-log and the gate missed it. */
export async function dirtyPathsInRepo(repoRoot: string): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=1", "--untracked-files=all"], {
      cwd: repoRoot,
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const dirty = new Set<string>();
    for (const line of stdout.split(/\r?\n/)) {
      const filePath = parsePorcelainPath(line);
      if (filePath) dirty.add(filePath);
    }
    return dirty;
  } catch {
    return new Set();
  }
}

/**
 * Human summary of the commits this run created — SHAs, subjects, and a
 * `--stat` of the files each touched — so the final report shows exactly what
 * landed (not just the agent's prose claim). Empty string when HEAD did not move.
 */
export async function commitSummarySince(repoRoot: string, beforeHead: string | null, afterHead: string | null): Promise<string> {
  if (!afterHead) return "";
  try {
    if (beforeHead && beforeHead !== afterHead) {
      const { stdout } = await execFileAsync("git", ["log", "--stat", "--format=commit %h %s", `${beforeHead}..${afterHead}`], {
        cwd: repoRoot,
        timeout: 5_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return stdout.trim();
    }
    if (!beforeHead) {
      // Fresh repo whose first commit this run created — show just that commit.
      const { stdout } = await execFileAsync("git", ["show", "--stat", "--format=commit %h %s", afterHead], {
        cwd: repoRoot,
        timeout: 5_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return stdout.trim();
    }
    return "";
  } catch {
    return "";
  }
}

export type RepoUncommitted = { repoRoot: string; files: string[] };

/**
 * Artifact hygiene: dirty paths that APPEARED during the run but belong to no
 * declared deliverable — scaffolds a subprocess dropped in the tree (the
 * audited case: a stray `fastlane/` from an aborted `fastlane init`). These
 * escape the commit-completeness gate by construction (it reads only the
 * mutation write-log, and a subprocess's files never enter it), so they are
 * diffed from the git snapshots instead: dirty at finalize, not dirty at
 * start, not attributed to the session. Suffix/prefix matching keeps a
 * workspace-relative attribution ("api/foo.go") aligned with a repo-relative
 * snapshot path, and anything under an attributed directory is attributed too
 * — generous on purpose: this feeds a NUDGE, so a false stray is worse than a
 * missed one. Ignored paths never appear (porcelain omits gitignored files).
 */
export function strayArtifactsSince(
  before: GitSnapshot | null,
  after: GitSnapshot | null,
  attributed: Iterable<string>,
): string[] {
  if (!after) return [];
  const beforeSet = new Set(before?.files ?? []);
  const attributedPaths = [...new Set([...attributed].map((p) => normalizeGitPath(p)).filter(Boolean))];
  const isAttributed = (candidate: string): boolean =>
    attributedPaths.some((known) =>
      known === candidate ||
      known.endsWith(`/${candidate}`) ||
      candidate.endsWith(`/${known}`) ||
      candidate.startsWith(`${known.replace(/\/$/, "")}/`)
    );
  return after.files.filter((file) => !beforeSet.has(file) && !isAttributed(normalizeGitPath(file)));
}

/**
 * Commit-completeness across EVERY repo the session wrote into (not just the
 * cwd). Cross-checks the run's write-log against live `git status`: any file the
 * run wrote that is still dirty (untracked / unstaged / staged-but-uncommitted)
 * is a completeness failure.
 *
 * This is the check that catches the "committed a file that references an
 * untracked sibling" shape — a green local build that fails to compile from a
 * clean checkout — and any second (nested) repo left dirty. It relies ONLY on
 * the mutation write-log (`write_file`/patch results), never on read paths, so
 * a file the run merely read can never be flagged.
 *
 * `writeLog` entries are workspace-relative; roots are discovered per file via
 * `git rev-parse`, so nested repos / submodules under the workspace are covered.
 * (A sibling repo written only via raw `run_shell` is out of scope — it never
 * enters the mutation write-log.)
 */
export async function sessionUncommittedFiles(workspace: string, writeLog: Iterable<string>): Promise<RepoUncommitted[]> {
  // Resolve symlinks up front so file paths line up with the realpath'd roots
  // `git rev-parse` returns (macOS /var → /private/var would otherwise mismatch).
  let realWorkspace = workspace;
  try {
    realWorkspace = await realpath(workspace);
  } catch {
    // Non-existent workspace: fall back to the given path.
  }
  const rootByDir = new Map<string, string | null>();
  const absByRoot = new Map<string, Set<string>>();
  for (const rel of new Set(writeLog)) {
    if (!rel || isIgnoredReportPath(normalizeGitPath(rel))) continue;
    const abs = resolve(realWorkspace, rel);
    const dir = dirname(abs);
    let root = rootByDir.get(dir);
    if (root === undefined) {
      root = await repoRootForPath(abs);
      rootByDir.set(dir, root);
    }
    if (!root) continue;
    if (!absByRoot.has(root)) absByRoot.set(root, new Set());
    absByRoot.get(root)!.add(abs);
  }
  const result: RepoUncommitted[] = [];
  for (const [root, absPaths] of absByRoot) {
    const dirty = await dirtyPathsInRepo(root);
    if (dirty.size === 0) continue;
    const uncommitted: string[] = [];
    for (const abs of absPaths) {
      const relToRoot = normalizeGitPath(relative(root, abs));
      if (dirty.has(relToRoot)) uncommitted.push(relToRoot);
    }
    if (uncommitted.length > 0) result.push({ repoRoot: root, files: uniqueSorted(uncommitted) });
  }
  return result;
}
