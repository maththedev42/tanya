// Exit sentinel: the beta.20 gates are correct but they arm at FINAL-REPORT
// time — a run that dies mid-work (killed serve child, provider exception,
// SIGINT) never reaches them, leaves no archive in .tanya/runs/, and can hand
// over a tree with 20 compile errors in silence (FinanceWorld T2/T3,
// 2026-07-18 night: 6 files created, zero builds, no report, no trace). This
// module moves the defense line from "end of run" to "ANY end of run":
//
// 1. On any ABNORMAL termination (exception thrown out of the runner, or a
//    terminating signal) it synchronously writes a minimal aborted-run archive
//    — runId, prompt, termination reason, changed files, uncommitted files,
//    whether any green build was observed — so the audit trail exists even
//    when the run didn't get to write the real one.
// 2. When that abnormal end leaves uncommitted changed files OR changed
//    sources with no green build observed, it also writes a LOUD marker,
//    `.tanya/LAST_RUN_FAILED.md`, so the next human or agent sees the hazard
//    immediately instead of discovering it at the next build.
// 3. Placement follows the TARGET repos, not just the session workspace. A
//    serve session driven from a workspace ROOT (mac app: `--cwd Appzinhos`)
//    edits files inside nested repos; the marker + an archive pointer must
//    land in EACH touched repo — the FinanceWorld run-3 audit looked in
//    FinanceWorld/.tanya, found nothing, and wrongly concluded the gates
//    never fired (the artifacts were one directory up, in the serve cwd).
// 4. kill -9 cannot be caught by 1–2. A periodic heartbeat (flushed every N
//    mutating tool results, and on a timer for external-backend runs) writes
//    `.tanya/RUN_IN_PROGRESS.md` into each touched repo; every graceful end
//    — finalize, exception, signal — removes it. A surviving heartbeat whose
//    pid is dead IS the death marker.
//
// The sentinel is a no-op once the run's real archive has landed
// (`state.archived = true` in the normal finalize path) — it can never
// shadow or contradict a completed run.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isFreshnessRelevantSource, lastGreenBuildAtMs, type VerificationEvent } from "./verificationFreshness";
import { writeArchivePointers } from "./runArchivePointer";

export type ExitSentinelState = {
  runId: string;
  workspace: string;
  prompt: string;
  // LIVE references into the run's own tracking arrays — the sentinel reads
  // whatever they contain at the moment of death.
  changedFiles: string[];
  verificationEvents: VerificationEvent[];
  // Set true by the normal finalize path once the real archive is written;
  // the sentinel then never fires.
  archived: boolean;
  terminationReason?: string;
  // Repos where a RUN_IN_PROGRESS heartbeat was written, so cleanup removes
  // exactly what this run created (two sessions can share a repo).
  heartbeatRepos: Set<string>;
  unregister: () => void;
};

const SENTINEL_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const HEARTBEAT_FILE = "RUN_IN_PROGRESS.md";

/** Uncommitted (dirty) paths in a repo, best-effort and bounded — safe to
 *  call from a signal handler (sync, short timeout, never throws). */
function uncommittedPathsSync(repoRoot: string): string[] {
  try {
    const out = execFileSync("git", ["status", "--porcelain=1", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
    });
    return out
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .slice(0, 100);
  } catch {
    return [];
  }
}

/** Sync, spawn-free enclosing-repo lookup: walk up from `startDir` until a
 *  `.git` entry (dir, or file for worktrees) is found. Signal-handler safe. */
export function enclosingGitRepoRootSync(startDir: string): string | null {
  let dir = resolve(startDir);
  for (let i = 0; i < 40; i += 1) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** All repo roots this run touches: the enclosing repo of each changed file
 *  (resolved against the workspace) plus the workspace's own repo, deduped.
 *  Falls back to the raw workspace when nothing is a git repo, so sentinel
 *  artifacts always have somewhere to land. */
function touchedRepoRootsSync(state: ExitSentinelState): string[] {
  const roots = new Set<string>();
  const workspaceRoot = enclosingGitRepoRootSync(state.workspace);
  if (workspaceRoot) roots.add(workspaceRoot);
  for (const file of state.changedFiles.slice(0, 200)) {
    const absolute = isAbsolute(file) ? file : join(state.workspace, file);
    const root = enclosingGitRepoRootSync(dirname(absolute));
    if (root) roots.add(root);
  }
  if (roots.size === 0) roots.add(state.workspace);
  return [...roots];
}

/** The subset of the run's changed files that live inside `repoRoot`. */
function changedFilesInRepo(state: ExitSentinelState, repoRoot: string): string[] {
  const prefix = `${resolve(repoRoot)}`;
  return state.changedFiles.filter((file) => {
    const absolute = resolve(isAbsolute(file) ? file : join(state.workspace, file));
    return absolute === prefix || absolute.startsWith(`${prefix}/`);
  });
}

function dirtyMarkerBody(state: ExitSentinelState, changed: string[], uncommitted: string[], greenBuildObserved: boolean): string {
  return [
    "# ⚠ LAST TANYA RUN DIED MID-WORK — TREE MAY NOT COMPILE",
    "",
    `- when: ${new Date().toISOString()}`,
    `- runId: ${state.runId} (aborted archive under ${join(state.workspace, ".tanya", "runs")})`,
    `- why it ended: ${state.terminationReason ?? "unknown abnormal termination"}`,
    `- green build observed during the run: ${greenBuildObserved ? "yes" : "NO"}`,
    "",
    "## Files this run changed here",
    ...(changed.length > 0 ? changed.map((file) => `- ${file}`) : ["- (none recorded)"]),
    "",
    "## Uncommitted at the moment of death",
    ...(uncommitted.length > 0 ? uncommitted.map((file) => `- ${file}`) : ["- (none)"]),
    "",
    "Build/verify BEFORE trusting this tree. Delete this file after handling.",
    "",
  ].join("\n");
}

/** Write the minimal aborted-run archive at the session workspace, and — per
 *  TOUCHED REPO — the dirty-exit marker (when that repo's tree is hazardous)
 *  plus a pointer to the archive. Synchronous throughout — it must complete
 *  inside a signal handler — and never throws. */
export function writeExitSentinel(state: ExitSentinelState): void {
  if (state.archived) return;
  try {
    const greenBuildObserved = lastGreenBuildAtMs(state.verificationEvents) !== null;
    const runsDir = join(state.workspace, ".tanya", "runs");
    const archivePath = join(runsDir, `${state.runId}.json`);
    const workspaceUncommitted = uncommittedPathsSync(state.workspace);
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      archivePath,
      JSON.stringify(
        {
          archiveVersion: 2,
          aborted: true,
          ts: new Date().toISOString(),
          runId: state.runId,
          prompt: state.prompt.slice(0, 200),
          terminationReason: state.terminationReason ?? "unknown abnormal termination",
          changedFiles: [...state.changedFiles],
          uncommittedFiles: workspaceUncommitted,
          greenBuildObserved,
          verdict: "FAIL",
        },
        null,
        2,
      ),
      "utf8",
    );
    // Per touched repo: hazard check against THAT repo's files, marker when
    // hazardous, pointer to the workspace archive (runArchivePointer skips
    // the self-pointer when the repo IS the workspace).
    const touched = touchedRepoRootsSync(state);
    writeArchivePointers(archivePath, state.runId, touched, runsDir);
    for (const repoRoot of touched) {
      const isWorkspace = resolve(repoRoot) === resolve(state.workspace);
      const changedHere = isWorkspace ? state.changedFiles : changedFilesInRepo(state, repoRoot);
      if (!isWorkspace && changedHere.length === 0) continue;
      // The workspace keeps the original whole-run hazard view (it may not be
      // a git repo at all); nested repos are judged on their own files.
      const uncommitted = isWorkspace ? workspaceUncommitted : uncommittedPathsSync(repoRoot);
      const changedBasenames = changedHere.map((file) => file.split("/").pop() ?? file);
      const changedUncommitted = uncommitted.filter((file) =>
        changedHere.includes(file) || changedBasenames.includes(file.split("/").pop() ?? file));
      const changedSources = changedHere.filter(isFreshnessRelevantSource);
      const hazardous = changedUncommitted.length > 0 || (changedSources.length > 0 && !greenBuildObserved);
      if (hazardous) {
        mkdirSync(join(repoRoot, ".tanya"), { recursive: true });
        writeFileSync(
          join(repoRoot, ".tanya", "LAST_RUN_FAILED.md"),
          dirtyMarkerBody(state, changedHere, uncommitted, greenBuildObserved),
          "utf8",
        );
      }
    }
  } catch {
    // The sentinel is last-resort telemetry — it must never mask the original failure.
  }
  // Any sentinel write supersedes the in-progress heartbeat.
  clearExitSentinelHeartbeats(state);
}

/** Periodic in-progress heartbeat: `.tanya/RUN_IN_PROGRESS.md` in each
 *  touched repo. Removed on every graceful end (finalize, exception, signal)
 *  — so a heartbeat that OUTLIVES its pid is the kill -9 death marker.
 *  Sync + never throws. */
export function flushExitSentinelHeartbeat(state: ExitSentinelState): void {
  if (state.archived) return;
  try {
    for (const repoRoot of touchedRepoRootsSync(state)) {
      const changedHere = resolve(repoRoot) === resolve(state.workspace)
        ? state.changedFiles
        : changedFilesInRepo(state, repoRoot);
      mkdirSync(join(repoRoot, ".tanya"), { recursive: true });
      writeFileSync(
        join(repoRoot, ".tanya", HEARTBEAT_FILE),
        [
          `# Tanya run ${state.runId} IN PROGRESS — or killed before cleanup`,
          "",
          `- pid: ${process.pid}`,
          `- lastHeartbeat: ${new Date().toISOString()}`,
          `- workspace: ${state.workspace}`,
          "",
          "A clean end of run removes this file. If it is still here and the",
          "pid above is not a live tanya process, the run was hard-killed",
          "(kill -9 leaves no other trace): treat this tree as UNVERIFIED —",
          "check `git status` and build before trusting it.",
          "",
          "## Files changed so far",
          ...(changedHere.length > 0 ? changedHere.map((file) => `- ${file}`) : ["- (none yet)"]),
          "",
        ].join("\n"),
        "utf8",
      );
      state.heartbeatRepos.add(repoRoot);
    }
  } catch {
    // Best-effort telemetry.
  }
}

/** Remove this run's heartbeats (only files that still name this runId — two
 *  sessions can share a repo). Sync + never throws. */
export function clearExitSentinelHeartbeats(state: ExitSentinelState): void {
  for (const repoRoot of state.heartbeatRepos) {
    try {
      const file = join(repoRoot, ".tanya", HEARTBEAT_FILE);
      if (existsSync(file) && readFileSync(file, "utf8").includes(state.runId)) {
        rmSync(file, { force: true });
      }
    } catch {
      // Best-effort cleanup.
    }
  }
  state.heartbeatRepos.clear();
}

/** Create the sentinel state and register terminating-signal handlers for the
 *  run's lifetime. The handler writes the sentinel, then: if ours is the only
 *  listener, re-raises the signal's default behavior; if the host process
 *  (e.g. serve) has its own handlers, it only records and lets them decide. */
export function registerExitSentinel(params: {
  runId: string;
  workspace: string;
  prompt: string;
  changedFiles: string[];
  verificationEvents: VerificationEvent[];
}): ExitSentinelState {
  const handlers = new Map<NodeJS.Signals, () => void>();
  const state: ExitSentinelState = {
    ...params,
    archived: false,
    heartbeatRepos: new Set<string>(),
    unregister: () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      handlers.clear();
    },
  };
  for (const signal of SENTINEL_SIGNALS) {
    const handler = () => {
      state.terminationReason = `signal: ${signal}`;
      writeExitSentinel(state);
      // Sole listener → restore default termination so the process still dies
      // the way the sender intended. Other listeners → they own the decision.
      if (process.listenerCount(signal) <= 1) {
        state.unregister();
        process.kill(process.pid, signal);
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Graceful-FAIL marker. A run that FINALIZES with blockers (repair budget
// exhausted, or none armed) leaves the same hazard as a dead run: a tree in a
// known-bad state. Write a structured LAST_RUN_FAILED.md so the next human,
// agent, or `tanya doctor` sees exactly what failed and what was tried —
// never end silently on top of a known FAIL. A later finalize that PASSES
// with gates armed clears it.
// ---------------------------------------------------------------------------

export function writeRunFailedMarker(params: {
  workspace: string;
  runId: string;
  blockers: string[];
  changedFiles: string[];
  uncommittedFiles: string[];
  repairAttemptsUsed?: number;
  /** How many recovery attempts the FAILED run represents (1 = it was the
   *  first recovery of an earlier FAIL). The next preflight reads this to
   *  brake non-converging recovery loops. Omitted/0 = not a recovery run. */
  recoveryAttempts?: number;
}): void {
  try {
    const dir = join(params.workspace, ".tanya");
    mkdirSync(dir, { recursive: true });
    const body = [
      "# ⚠ LAST TANYA RUN FINALIZED AS FAIL — TREE IS IN A KNOWN-BAD STATE",
      "",
      `- when: ${new Date().toISOString()}`,
      `- runId: ${params.runId} (archive under ${join(params.workspace, ".tanya", "runs")})`,
      ...(params.recoveryAttempts !== undefined && params.recoveryAttempts > 0
        ? [`- recoveryAttempts: ${params.recoveryAttempts}`]
        : []),
      ...(params.repairAttemptsUsed !== undefined
        ? [`- repair attempts used before finalizing FAIL: ${params.repairAttemptsUsed}`]
        : []),
      "",
      "## Blockers (verbatim)",
      ...(params.blockers.length > 0 ? params.blockers.map((blocker) => `- ${blocker}`) : ["- (none recorded)"]),
      "",
      "## Files this run changed",
      ...(params.changedFiles.length > 0 ? params.changedFiles.slice(0, 100).map((file) => `- ${file}`) : ["- (none recorded)"]),
      "",
      "## Still uncommitted at finalize",
      ...(params.uncommittedFiles.length > 0 ? params.uncommittedFiles.slice(0, 100).map((file) => `- ${file}`) : ["- (none)"]),
      "",
      `Run \`tanya doctor --run ${params.runId}\` for a diagnosis and a ready repair prompt.`,
      "A later Tanya run that finalizes PASSED (gates armed) in this workspace clears this marker.",
      "",
    ].join("\n");
    writeFileSync(join(dir, "LAST_RUN_FAILED.md"), body);
  } catch {
    // Marker is best-effort — never fail a run over it.
  }
}

export function clearRunFailedMarker(workspace: string): void {
  try {
    rmSync(join(workspace, ".tanya", "LAST_RUN_FAILED.md"), { force: true });
  } catch {
    // best-effort
  }
}
