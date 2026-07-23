import { join } from "node:path";
import { builtinAdapters } from "./adapters";
import { detectPlatform } from "./detect";
import { realRuntimeExec } from "./process";
import {
  makeBootCheck,
  makeBootVerdict,
  normalizeRuntimePlatform,
  RUNTIME_PLATFORMS,
  type BootAdapter,
  type BootVerdict,
  type RuntimeContext,
  type RuntimeExec,
  type RuntimePlatform,
  type UiModelConfig,
} from "./types";

export const DEFAULT_WARMUP_MS = 8_000;

// A caller mistake (unknown platform, undetectable workspace) — exits 1 from
// the CLI but is not a boot FAIL with evidence.
export class RuntimeUsageError extends Error {}

export type RunBootTestOptions = {
  workspace: string;
  platform?: string | undefined;
  warmupMs?: number | undefined;
  keepAlive?: boolean | undefined;
  record?: boolean | undefined;
  tier1?: boolean | undefined;
  uiModel?: UiModelConfig | undefined;
  runId?: string | undefined;
  exec?: RuntimeExec | undefined;
  emit?: ((message: string) => void) | undefined;
  // Test seam; production always uses the builtin registry.
  adapters?: BootAdapter[] | undefined;
};

const PLATFORM_LIST = `${RUNTIME_PLATFORMS.join("|")} (or landing)`;

export async function runBootTest(options: RunBootTestOptions): Promise<BootVerdict> {
  const exec = options.exec ?? realRuntimeExec();
  const emit = options.emit ?? (() => {});
  const adapters = options.adapters ?? builtinAdapters;
  const startedAt = exec.now();

  let platform: RuntimePlatform;
  if (options.platform !== undefined) {
    const normalized = normalizeRuntimePlatform(options.platform);
    if (!normalized) {
      throw new RuntimeUsageError(`Unknown platform "${options.platform}". Expected one of: ${PLATFORM_LIST}.`);
    }
    platform = normalized;
  } else {
    const detected = detectPlatform(exec, options.workspace);
    if (!detected) {
      throw new RuntimeUsageError(`Could not detect the app platform in this workspace. Pass --platform ${PLATFORM_LIST}.`);
    }
    platform = detected.platform;
    emit(`detected platform: ${detected.platform} (${detected.evidence})`);
  }

  const adapter = adapters.find((candidate) => candidate.platform === platform);
  if (!adapter) {
    throw new RuntimeUsageError(`No boot harness is implemented for platform "${platform}" yet.`);
  }

  const runId = options.runId ?? defaultRunId(exec);
  const evidenceDir = join(options.workspace, ".tanya", "runtime", runId);
  try {
    await exec.mkdirp(evidenceDir);
  } catch {
    // Evidence is best-effort; the verdict itself must still be produced.
  }

  const ctx: RuntimeContext = {
    workspace: options.workspace,
    runId,
    evidenceDir,
    warmupMs: options.warmupMs ?? DEFAULT_WARMUP_MS,
    keepAlive: options.keepAlive ?? false,
    record: options.record ?? false,
    tier1: options.tier1 ?? false,
    ...(options.uiModel !== undefined ? { uiModel: options.uiModel } : {}),
    exec,
    emit,
  };

  // The skipped-never-failure invariant lives here: a capability miss becomes
  // a skipped verdict before the adapter's boot path can ever run, and
  // adapters have no other way to produce a skip.
  let verdict: BootVerdict;
  const capability = await adapter.capabilityProbe(ctx);
  if (!capability.ok) {
    emit(`skipped: ${capability.reason}`);
    verdict = makeBootVerdict({
      status: "skipped",
      platform,
      reason: capability.reason,
      checks: [
        makeBootCheck({
          id: "runtime-capability",
          description: "host capability probe",
          passed: true,
          skipped: true,
          detail: capability.reason,
        }),
      ],
      evidence: [],
    });
  } else {
    try {
      verdict = await adapter.boot(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit(`boot harness error: ${message}`);
      verdict = makeBootVerdict({
        status: "fail",
        platform,
        reason: `boot harness error: ${message}`,
        failedCheck: "launch-failed",
        checks: [
          makeBootCheck({
            id: "runtime-launch",
            description: "boot harness execution",
            passed: false,
            detail: message,
          }),
        ],
        evidence: [],
      });
    }
  }

  verdict = { ...verdict, durationMs: exec.now() - startedAt, evidenceDir };
  try {
    await exec.writeFile(join(evidenceDir, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
  } catch {
    // Best-effort; never mask the verdict with an evidence-write failure.
  }
  emit(`verdict: ${verdict.status.toUpperCase()} — ${verdict.reason}`);
  return verdict;
}

function defaultRunId(exec: RuntimeExec): string {
  const stamp = new Date(exec.now()).toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  return `boot-${stamp}`;
}

export { realRuntimeExec } from "./process";
export * from "./types";
