import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envValue } from "../config/envCompat";
import { recordGoldenTaskMemory } from "../memory/goldenTasks";
import { recordRepairRunMemory, type RepairAttemptSnapshot } from "../memory/repairRuns";
import { appendTaskHistory } from "../memory/taskHistory";
import { appendTaskToVault } from "../obsidian/vaultAppender";
import { RUNNING_BUILT_AT, RUNNING_VERSION } from "./buildInfo";
import { appendLedgerRecord } from "./runLedger";
import { writeArchivePointers } from "./runArchivePointer";
import type { TanyaRunContext } from "../context/runContext";
import type { FinalMetrics, TanyaFinalManifest } from "./runner";

// The memory side-effects every finalized run must record, shared by the
// native runner and the external-backend runner. External runs used to skip
// all four silently — a completed `--backend claude` task left no golden
// memory, task history, obsidian note, or repair memory.

export async function appendObsidianTaskIfConfigured(manifest: TanyaFinalManifest, runContext?: TanyaRunContext): Promise<void> {
  const metadataVault = runContext?.metadata?.obsidianVault;
  const vaultPath = typeof metadataVault === "string" && metadataVault.trim()
    ? metadataVault.trim()
    : envValue({}, "TANYA_OBSIDIAN_VAULT").trim();
  if (!vaultPath) return;
  try {
    await appendTaskToVault(vaultPath, manifest, runContext);
  } catch {
    // Obsidian logging is best-effort and must never fail a Tanya run.
  }
}

export async function appendTaskHistorySilently(
  workspace: string,
  prompt: string,
  manifest: TanyaFinalManifest,
  runContext?: TanyaRunContext,
): Promise<void> {
  try {
    await appendTaskHistory(workspace, prompt, manifest, runContext);
  } catch {
    // Local history is best-effort and must never fail a Tanya run.
  }
}

export async function recordRepairRunMemorySilently(
  runContext: TanyaRunContext | undefined,
  attempts: RepairAttemptSnapshot[],
  manifest: TanyaFinalManifest,
): Promise<void> {
  try {
    await recordRepairRunMemory(runContext, attempts, manifest);
  } catch {
    // Cross-session repair memory is best-effort and must never fail a Tanya run.
  }
}

// Keep at most this many run summary files per workspace; older ones are deleted.
// One workspace can produce 30+ run files in a single session (orchestrated loops),
// so the directory grows unbounded without rotation.
export const RUN_SUMMARY_MAX_FILES = 50;

export function rotateRunSummaryFiles(runsDir: string): void {
  try {
    const entries = readdirSync(runsDir).filter((f) => f.endsWith(".json")).sort();
    const excess = entries.length - RUN_SUMMARY_MAX_FILES;
    if (excess <= 0) return;
    for (const stale of entries.slice(0, excess)) {
      try { unlinkSync(join(runsDir, stale)); } catch { /* best-effort */ }
    }
  } catch {
    // Rotation must never fail the task.
  }
}

// The single archive writer for completed runs, native and external. External
// runs have no token metrics (the external CLI owns them) — their archives
// simply omit the metric fields but keep the verdict/gate breadcrumbs the
// doctor and forensics read (the old external writer nested everything under
// `manifest`, which the doctor's top-level RunArchive fields never saw).
export function writeRunArchive(params: {
  workspace: string;
  runId: string;
  parentRunId?: string;
  prompt: string;
  provider: string;
  model: string;
  backend?: string;
  metrics?: FinalMetrics;
  manifest: TanyaFinalManifest;
}): void {
  try {
    const runsDir = join(params.workspace, ".tanya", "runs");
    const outputDir = params.parentRunId ? join(runsDir, params.parentRunId) : runsDir;
    mkdirSync(outputDir, { recursive: true });
    const logPath = join(outputDir, `${params.runId}.json`);
    writeFileSync(
      logPath,
      JSON.stringify(
        {
          // Bumped to 2 when the structured `gates` section + binary identity
          // were added. Old (v1) archives are NOT migrated; readers key on this.
          archiveVersion: 2,
          ts: new Date().toISOString(),
          runId: params.runId,
          ...(params.parentRunId ? { parentRunId: params.parentRunId } : {}),
          prompt: params.prompt.slice(0, 200),
          provider: params.provider,
          model: params.model,
          ...(params.backend ? { backend: params.backend } : {}),
          // Which code actually ran — so future forensics never have to guess
          // (the beta.9 forensics burned time eliminating a stale-binary theory).
          binaryVersion: RUNNING_VERSION,
          ...(RUNNING_BUILT_AT ? { binaryBuiltAt: RUNNING_BUILT_AT } : {}),
          ...(params.manifest.binaryStale ? { binaryStale: true } : {}),
          ...(params.metrics
            ? {
                durationMs: params.metrics.durationMs,
                promptTokens: params.metrics.promptTokens,
                completionTokens: params.metrics.completionTokens,
                reasoningTokens: params.metrics.reasoningTokens,
                cachedPromptTokens: params.metrics.cachedPromptTokens,
                systemPromptTokens: params.metrics.systemPromptTokens,
                repoMapTokens: params.metrics.repoMapTokens,
                toolResultTokens: params.metrics.toolResultTokens,
              }
            : {}),
          changedFiles: params.manifest.changedFiles,
          blockers: params.manifest.blockers,
          // Verdict + gate breadcrumbs, so a forensic reads the outcome straight
          // from the archive (interactive runs archive to the SERVE cwd, not the
          // nested target repo — the gotcha that hid these during the audit).
          verdict: params.manifest.blockers.length > 0 ? "FAIL" : "PASSED",
          ...(params.manifest.gateLog ? { gateLog: params.manifest.gateLog } : {}),
          ...(params.manifest.gates ? { gates: params.manifest.gates } : {}),
          ...(params.manifest.touchedRepos && params.manifest.touchedRepos.length > 0
            ? { touchedRepos: params.manifest.touchedRepos }
            : {}),
          ...(params.metrics
            ? {
                toolCallCount: params.metrics.toolCallCount,
                repairAttemptCount: params.metrics.repairAttemptCount,
                retryAttemptCount: params.metrics.retryAttemptCount,
              }
            : {}),
          validation: params.manifest.validation ?? null,
          artifactsRead: params.manifest.artifactsRead,
        },
        null,
        2,
      ),
      "utf8",
    );
    rotateRunSummaryFiles(outputDir);
    // Discoverability: a run driven from a workspace root archives here, but an
    // auditor looks in each touched repo's .tanya/runs/ first. Drop a pointer
    // file there so the archive is findable from the repo. Best-effort.
    writeArchivePointers(logPath, params.runId, params.manifest.touchedRepos ?? [], outputDir);
  } catch {
    // Run logs are best-effort and must never fail the task.
  }
}

export async function recordRunMemorySideEffects(params: {
  workspace: string;
  prompt: string;
  manifest: TanyaFinalManifest;
  runContext?: TanyaRunContext;
  repairAttempts?: RepairAttemptSnapshot[];
}): Promise<void> {
  if (params.manifest.runId) {
    appendLedgerRecord(params.workspace, {
      type: "run_end",
      runId: params.manifest.runId,
      ts: new Date().toISOString(),
      verdict: params.manifest.blockers.length > 0 ? "FAIL" : "PASSED",
      blockers: params.manifest.blockers.slice(0, 10),
      changedFiles: params.manifest.changedFiles.slice(0, 50),
    });
  }
  await recordGoldenTaskMemory(params.workspace, params.manifest, params.runContext);
  await appendTaskHistorySilently(params.workspace, params.prompt, params.manifest, params.runContext);
  await appendObsidianTaskIfConfigured(params.manifest, params.runContext);
  await recordRepairRunMemorySilently(params.runContext, params.repairAttempts ?? [], params.manifest);
}
