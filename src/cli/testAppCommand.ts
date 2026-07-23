import { captureGitSnapshot } from "../agent/git";
import { createJsonlSink } from "../events/jsonl";
import { createCosmoChatFinalizeSink } from "../integrations/cosmochatFinalize";
import { createHumanSink } from "../ui/humanSink";
import type { EventSink } from "../events/types";
import { autoCleanTanyaDir, formatBytes } from "../maintenance/clean";
import { postRunBuildHygiene } from "../maintenance/buildHygiene";
import { RuntimeUsageError, runBootTest } from "../runtime";
import { bootVerdictToManifest, buildBootReportText } from "../runtime/manifest";
import { resolveUiModelConfig } from "../runtime/uiModel";

export interface TestAppCommandOptions {
  cwd: string;
  platform?: string | undefined;
  warmupMs?: number | undefined;
  json?: boolean | undefined;
  keepAlive?: boolean | undefined;
  record?: boolean | undefined;
  tier1?: boolean | undefined;
  sink?: EventSink | undefined;
}

// Headless Tier-0 runtime test: boots the built app in this workspace and
// reports pass/fail/skip with evidence. Deliberately requires no provider
// config — the harness is fully deterministic. Exit code 0 = pass or skip,
// 1 = fail or usage error.
export async function runTestAppCommand(options: TestAppCommandOptions): Promise<number> {
  const sink =
    options.sink ??
    createCosmoChatFinalizeSink(options.json ? createJsonlSink() : createHumanSink(process.stdout));
  try {
    const uiModel = options.tier1 ? resolveUiModelConfig() : undefined;
    if (options.tier1 && !uiModel) {
      await sink({
        type: "status",
        message: "[runtime] --tier1 needs a model key (DEEPSEEK_API_KEY / TANYA_API_KEY / TANYA_UI_API_KEY) — skipping UI test",
      });
    }
    const verdict = await runBootTest({
      workspace: options.cwd,
      platform: options.platform,
      warmupMs: options.warmupMs,
      keepAlive: options.keepAlive,
      record: options.record,
      tier1: options.tier1 ?? false,
      ...(uiModel !== undefined ? { uiModel } : {}),
      emit: (message) => {
        void Promise.resolve(sink({ type: "status", message: `[runtime] ${message}` })).catch(() => {});
      },
    });
    const cleaned = autoCleanTanyaDir(options.cwd);
    if (cleaned && cleaned.freedBytes > 0) {
      await sink({
        type: "status",
        message: `[runtime] auto-clean reclaimed ${formatBytes(cleaned.freedBytes)} of old evidence (TANYA_AUTO_CLEAN=0 to disable)`,
      });
    }
    postRunBuildHygiene();
    const git = await captureGitSnapshot(options.cwd);
    const manifest = bootVerdictToManifest(verdict, git);
    await sink({
      type: "final",
      message: buildBootReportText(verdict, manifest),
      manifest: manifest as unknown as Record<string, unknown>,
    });
    return verdict.status === "fail" ? 1 : 0;
  } catch (err) {
    if (err instanceof RuntimeUsageError) {
      await sink({ type: "error", message: err.message });
      return 1;
    }
    throw err;
  }
}
