import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { captureGitSnapshot, uniqueSorted } from "./git";
import { buildFinalManifest, ensureCodingReport } from "./report";
import { createRootRunId } from "./subAgentContext";
import {
  clearExitSentinelHeartbeats,
  clearRunFailedMarker,
  flushExitSentinelHeartbeat,
  registerExitSentinel,
  writeExitSentinel,
  writeRunFailedMarker,
  type ExitSentinelState,
} from "./exitSentinel";
import { resolveExecutor, listExecutors } from "../executors/index";
import type { ExecutorId } from "../executors/types";
import type { EventSink } from "../events/types";
import type { RunAgentResult, TanyaFinalManifest } from "./runner";
import type { TanyaRunContext } from "../context/runContext";
import { recoveryPreflight } from "./runRecovery";
import { prependRecoveryBlock } from "./recoveryPrompt";
import { recordRunMemorySideEffects, writeRunArchive } from "./runLifecycle";

export interface ExternalRunOptions {
  backend: ExecutorId;
  prompt: string;
  cwd: string;
  sink: EventSink;
  runContext?: TanyaRunContext;
  /** AbortSignal from the subagent job. */
  signal?: AbortSignal;
  /** Progress callback for streaming lines back to the job manager. */
  onProgress?: (line: string) => void;
}

export async function runWithExternalBackend(
  options: ExternalRunOptions,
): Promise<RunAgentResult> {
  // Same wrapper shape as runAgent/runAgentCore: the sentinel must see every
  // way out of an external-backend run — exception, signal, and (via the
  // timer heartbeat) kill -9 while the external CLI grinds.
  const sentinelBox: { state?: ExitSentinelState; timer?: NodeJS.Timeout } = {};
  try {
    return await runWithExternalBackendCore(options, sentinelBox);
  } catch (err) {
    if (sentinelBox.state && !sentinelBox.state.archived) {
      sentinelBox.state.terminationReason = `exception: ${err instanceof Error ? err.message : String(err)}`;
      writeExitSentinel(sentinelBox.state);
    }
    throw err;
  } finally {
    if (sentinelBox.timer) clearInterval(sentinelBox.timer);
    if (sentinelBox.state) {
      clearExitSentinelHeartbeats(sentinelBox.state);
      sentinelBox.state.unregister();
    }
  }
}

async function runWithExternalBackendCore(
  options: ExternalRunOptions,
  sentinelBox: { state?: ExitSentinelState; timer?: NodeJS.Timeout },
): Promise<RunAgentResult> {
  const { backend, prompt: originalPrompt, cwd, sink, runContext, onProgress } = options;

  // ── Recovery preflight ──────────────────────────────────────────────────
  // If the last run in this workspace FAILed (LAST_RUN_FAILED.md marker),
  // call the doctor and prepend a RECOVERY block to the task prompt so the
  // external agent stabilizes the tree BEFORE executing the actual task.
  let prompt = originalPrompt;
  const recovery = recoveryPreflight(cwd, { sink, ...(runContext ? { runContext } : {}) });
  if (recovery) {
    prompt = prependRecoveryBlock(recovery.recoveryBlock, originalPrompt);
    await sink({ type: "status", message: `recovering from failed run ${recovery.runId}` });
  }
  // ─────────────────────────────────────────────────────────────────────────

  // 1. Resolve and validate executor.
  const executor = resolveExecutor(backend);
  if (!executor) {
    const available = await listExecutors();
    const lines = available.map(
      (e) => `  ${e.id}${e.available ? " (available)" : " (unavailable — not installed or not logged in)"}`,
    );
    const msg = [
      `Backend "${backend}" is unknown or unavailable.`,
      "Available backends:",
      ...lines,
    ].join("\n");
    await sink({ type: "final", message: msg, suppressHumanMessage: true });
    // Return a failed manifest so the CLI can format it.
    const manifest = emptyFailedManifest(cwd, [`unknown backend: ${backend}`]);
    return { message: msg, manifest };
  }

  const available = await executor.available();
  if (!available) {
    const executors = await listExecutors();
    const lines = executors.map(
      (e) => `  ${e.id}${e.available ? " (available)" : " (unavailable — not installed or not logged in)"}`,
    );
    const msg = [
      `Backend "${backend}" is not available.`,
      `Install it and log in, then retry.`,
      "All backends:",
      ...lines,
    ].join("\n");
    await sink({ type: "final", message: msg, suppressHumanMessage: true });
    const manifest = emptyFailedManifest(cwd, [`unavailable backend: ${backend}`]);
    return { message: msg, manifest };
  }

  // 2. Capture before snapshot.
  const beforeGitSnapshot = await captureGitSnapshot(cwd);
  const runStartedAt = new Date();
  const runId = createRootRunId(runStartedAt);
  const sentinel = registerExitSentinel({
    runId,
    workspace: cwd,
    prompt,
    changedFiles: [],
    verificationEvents: [],
  });
  sentinelBox.state = sentinel;
  flushExitSentinelHeartbeat(sentinel);
  sentinelBox.timer = setInterval(() => flushExitSentinelHeartbeat(sentinel), 30_000);
  sentinelBox.timer.unref?.();

  // 3. Emit subtask-start event so consumers see life.
  await sink({
    type: "subtask_start",
    subtask_id: runId,
    title: `Running ${backend}...`,
    files: [],
  });

  // 4. Run the executor with streaming progress.
  const progressLines: string[] = [];
  const result = await executor.run({
    prompt,
    cwd,
    timeoutMs: 600_000, // 10-minute default — external CLIs can be slow.
    onProgress: (line) => {
      progressLines.push(line);
      onProgress?.(line);
      // Emit JSON progress events when recognizable. Sink implementations may
      // be sync (void) — normalize through Promise.resolve before swallowing.
      void Promise.resolve(sink({
        type: "subtask_start",
        subtask_id: runId,
        title: line.slice(0, 120),
        files: [],
      })).catch(() => {});
    },
  });

  // 5. Handle auth expired.
  if (result.authExpired) {
    const loginHint =
      backend === "claude"
        ? "claude login"
        : backend === "codex"
          ? "codex login"
          : "agent login";
    const blocker = `auth expired — re-run \`${loginHint}\` and retry`;
    await sink({
      type: "subtask_done",
      subtask_id: runId,
      files_changed: [],
      summary: blocker,
      ok: false,
    });
    const manifest = emptyFailedManifest(cwd, [blocker], backend);
    writeRunArchive({ workspace: cwd, runId, prompt, provider: `external:${backend}`, model: backend, backend, manifest });
    sentinel.archived = true;
    return { message: `Blocked: ${blocker}`, manifest };
  }

  // 6. Handle timeout.
  if (result.timedOut) {
    const blocker = `backend "${backend}" timed out after 10 minutes`;
    await sink({
      type: "subtask_done",
      subtask_id: runId,
      files_changed: [],
      summary: blocker,
      ok: false,
    });
    const manifest = emptyFailedManifest(cwd, [blocker], backend);
    writeRunArchive({ workspace: cwd, runId, prompt, provider: `external:${backend}`, model: backend, backend, manifest });
    sentinel.archived = true;
    return { message: `Blocked: ${blocker}`, manifest };
  }

  // 7. Derive changed files from git diff since before-snapshot.
  // No mutation write-log for an external agent — attribution degrades to
  // attribution-by-diff. Use `git diff --name-only` between before and after.
  let diffChangedFiles: string[] = [];
  try {
    const diffOutput = execFileSync(
      "git",
      ["diff", "--name-only", beforeGitSnapshot?.head ?? "HEAD"],
      { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    diffChangedFiles = diffOutput
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    // Also include untracked files (files created by the external CLI that
    // haven't been git-added).
    const untrackedOutput = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    const untracked = untrackedOutput
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    diffChangedFiles = uniqueSorted([...diffChangedFiles, ...untracked]);
  } catch {
    // Repo may not be a git repo — changedFiles stays empty.
  }

  // The sentinel's live view: if the process dies during gate evaluation
  // below, the aborted archive still names what the external CLI changed.
  sentinel.changedFiles = diffChangedFiles;
  flushExitSentinelHeartbeat(sentinel);

  // 8. Emit subtask done.
  const ok = result.ok && !result.authExpired && !result.timedOut;
  await sink({
    type: "subtask_done",
    subtask_id: runId,
    files_changed: diffChangedFiles,
    summary: result.finalText || `${backend} finished with exit ${result.exitCode}`,
    ok,
  });

  // 9. Build final manifest with Tanya's gates applied to the external work.
  // Parse verification lines from the executor transcript.
  const verificationLines = extractVerificationLines(progressLines, result.transcript);

  const startedAtMs = runStartedAt.getTime();
  const manifest = await buildFinalManifest({
    workspace: cwd,
    beforeGitSnapshot,
    changed: diffChangedFiles,
    verificationLines,
    toolErrorCount: ok ? 0 : 1,
    readArtifactPaths: [],
    readContextPaths: [],
    createdArtifactPaths: [],
    blockers: ok ? [] : [`backend "${backend}" exited with code ${result.exitCode}`],
    runContext,
    prompt,
    runId,
    runStartedAtMs: startedAtMs,
    interactive: false,
  });

  // 10. Attach the backend that performed the work (typed field on the manifest).
  manifest.backend = backend;

  // 11. Build the final report message.
  const message = ensureCodingReport(result.transcript || result.finalText || "", manifest, runContext, {
    workspace: cwd,
    prompt,
  });

  // 12. Record the memory side-effects (golden tasks, task history, obsidian,
  // repair memory) exactly like the native runner's finalize tail — external
  // runs used to skip all four silently. Then archive; the real archive
  // supersedes the sentinel. Same graceful-FAIL contract as the native
  // runner: a FAIL leaves a structured marker, a PASSED with gates armed
  // clears it.
  await recordRunMemorySideEffects({
    workspace: cwd,
    prompt,
    manifest,
    ...(runContext ? { runContext } : {}),
  });
  writeRunArchive({ workspace: cwd, runId, prompt, provider: `external:${backend}`, model: backend, backend, manifest });
  if (manifest.blockers.length > 0) {
    writeRunFailedMarker({
      workspace: cwd,
      runId,
      blockers: manifest.blockers,
      changedFiles: manifest.changedFiles,
      uncommittedFiles: manifest.uncommittedFiles,
      ...(recovery ? { recoveryAttempts: recovery.attempts + 1 } : {}),
    });
  } else if (manifest.gates?.armed) {
    clearRunFailedMarker(cwd);
  }
  sentinel.archived = true;

  await sink({ type: "final", message, manifest, suppressHumanMessage: false });

  return { message, manifest };
}

function emptyFailedManifest(
  cwd: string,
  blockers: string[],
  backend?: string,
): TanyaFinalManifest {
  let root: string | null = null;
  let head: string | null = null;
  try {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    root = repoRoot || null;
  } catch { /* not a repo */ }
  try {
    const shortHead = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    head = shortHead || null;
  } catch { /* not a repo */ }

  const m = {
    schemaVersion: 1 as const,
    changedFiles: [],
    uncommittedFiles: [],
    artifactsRead: [],
    artifactsCreated: [],
    contextFilesRead: [],
    verification: [],
    git: { root, head },
    toolErrors: 0,
    blockers,
  };
  return { ...m, ...(backend ? { backend } : {}) } as TanyaFinalManifest;
}

function extractVerificationLines(
  progressLines: string[],
  transcript: string,
): string[] {
  // Parse the executor transcript for verification-shaped lines.
  // Look for patterns like:
  //   "npm test" → "PASS" or "FAIL"
  //   "Verification: <cmd> -> <result>"
  const lines: string[] = [];
  const source = transcript || progressLines.join("\n");

  // Look for Tanya-style verification lines already in the output.
  for (const line of source.split("\n")) {
    if (/^Verification:/.test(line.trim())) {
      lines.push(line.trim());
    }
  }

  // Also look for common test runner output.
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (
      /^\d+ passing/.test(trimmed) ||
      /^\d+ failing/.test(trimmed) ||
      /^Tests: \d+ passed/.test(trimmed) ||
      /^PASS /.test(trimmed) ||
      /^FAIL /.test(trimmed)
    ) {
      lines.push(`Verification: ${trimmed}`);
    }
  }

  return lines.slice(0, 50); // Cap at reasonable size.
}
