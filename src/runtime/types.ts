import type { VerifierShell } from "../agent/verifier/types";
import type { BlankImageResult } from "./blankFrame";
import type { UiModelConfig, UIVerdict } from "./tier1/types";

export type { UiModelConfig } from "./tier1/types";

// ──────────────────────────────────────────────────────────
// Tier-0 runtime boot test ("does it boot") — shared types.
//
// The runtime tester is the second ring of Tanya's verify chain: after the
// code verifier says the change is sound and the app builds, the boot harness
// launches the built app, watches it through a warmup window, and produces a
// deterministic verdict with evidence. Capability gaps on the host (no Xcode,
// no AVD, no Chrome) are SKIPPED, never failures — only the orchestrator may
// construct a skipped verdict, which makes that invariant structural.
// ──────────────────────────────────────────────────────────

export type RuntimePlatform = "backend" | "web" | "script" | "android" | "ios" | "macos";

export const RUNTIME_PLATFORMS: readonly RuntimePlatform[] = [
  "backend",
  "web",
  "script",
  "android",
  "ios",
  "macos",
];

// "landing" is accepted as input and normalized to "web" (same harness).
export function normalizeRuntimePlatform(input: string): RuntimePlatform | null {
  const value = input.trim().toLowerCase();
  if (value === "landing") return "web";
  return (RUNTIME_PLATFORMS as readonly string[]).includes(value) ? (value as RuntimePlatform) : null;
}

export type BootFailureKind =
  | "provision-failed"
  | "launch-failed"
  | "crash"
  | "no-process"
  | "http-down"
  | "nonzero-exit"
  | "blank-first-frame"
  | "timeout"
  | "ui-assertion-failed";

export type BootEvidenceKind = "screenshot" | "video" | "log" | "crashlog" | "http";

export type BootEvidence = {
  kind: BootEvidenceKind;
  path?: string;
  excerpt?: string;
};

export function makeEvidence(
  kind: BootEvidenceKind,
  fields: { path?: string | undefined; excerpt?: string | undefined } = {},
): BootEvidence {
  const evidence: BootEvidence = { kind };
  if (fields.path !== undefined) evidence.path = fields.path;
  if (fields.excerpt !== undefined) evidence.excerpt = fields.excerpt;
  return evidence;
}

export type BootCheckResult = {
  id: "runtime-provision" | "runtime-launch" | "runtime-alive" | "runtime-surface" | "runtime-capability" | "runtime-ui";
  description: string;
  passed: boolean;
  skipped?: boolean;
  detail?: string;
};

export function makeBootCheck(input: {
  id: BootCheckResult["id"];
  description: string;
  passed: boolean;
  skipped?: boolean | undefined;
  detail?: string | undefined;
}): BootCheckResult {
  const check: BootCheckResult = {
    id: input.id,
    description: input.description,
    passed: input.passed,
  };
  if (input.skipped !== undefined) check.skipped = input.skipped;
  if (input.detail !== undefined) check.detail = input.detail;
  return check;
}

export type BootVerdictStatus = "pass" | "fail" | "skipped";

export type BootVerdict = {
  status: BootVerdictStatus;
  platform: RuntimePlatform;
  reason: string;
  failedCheck?: BootFailureKind;
  checks: BootCheckResult[];
  evidence: BootEvidence[];
  durationMs: number;
  evidenceDir?: string;
  // Tier-1 agentic UI verdict, attached (pass or fail) when the UI test ran.
  ui?: UIVerdict;
};

export function makeBootVerdict(input: {
  status: BootVerdictStatus;
  platform: RuntimePlatform;
  reason: string;
  failedCheck?: BootFailureKind | undefined;
  checks: BootCheckResult[];
  evidence: BootEvidence[];
  durationMs?: number | undefined;
  evidenceDir?: string | undefined;
  ui?: UIVerdict | undefined;
}): BootVerdict {
  const verdict: BootVerdict = {
    status: input.status,
    platform: input.platform,
    reason: input.reason,
    checks: input.checks,
    evidence: input.evidence,
    durationMs: input.durationMs ?? 0,
  };
  if (input.failedCheck !== undefined) verdict.failedCheck = input.failedCheck;
  if (input.evidenceDir !== undefined) verdict.evidenceDir = input.evidenceDir;
  if (input.ui !== undefined) verdict.ui = input.ui;
  return verdict;
}

// ──────────────────────────────────────────────────────────
// Long-running launch handle (a booted server/app under observation).
// ──────────────────────────────────────────────────────────

export type LaunchOptions = {
  command: string;
  args: string[];
  cwd: string;
  // Extra variables merged over the harness base env (inherited env + standard
  // PATH dirs). Use for PORT and friends; do not pass a full replacement env.
  env?: NodeJS.ProcessEnv | undefined;
  // When set, all stdout/stderr is also appended to this file as it arrives.
  logPath?: string | undefined;
};

export type LaunchHandle = {
  pid: number | null;
  alive(): boolean;
  exit(): { code: number | null; signal: NodeJS.Signals | null } | null;
  logTail(maxBytes?: number): string;
  // Resolves true if the process exited within the window, false if still alive.
  waitExit(ms: number): Promise<boolean>;
  // SIGTERM the whole process group, escalate to SIGKILL after a grace period.
  killTree(): Promise<void>;
  // SIGINT the process group and wait for a graceful exit — for tools that
  // finalize their output on interrupt (simctl recordVideo). Escalates to
  // SIGKILL after the grace period.
  interrupt(): Promise<void>;
};

export type HttpResponseSummary = { status: number; body: string };

// ──────────────────────────────────────────────────────────
// Injected execution seam. Adapters never touch child_process/fs/fetch
// directly — everything goes through RuntimeExec so unit tests are hermetic
// (scripted responses, instant sleep, fake clock).
// ──────────────────────────────────────────────────────────

export type RuntimeExec = {
  // Run-to-completion command (same contract as the verifier shell).
  run: VerifierShell;
  // Long-running launch in its own process group.
  launch(options: LaunchOptions): Promise<LaunchHandle>;
  fileExists(path: string): boolean;
  readText(path: string): string | null;
  writeFile(path: string, data: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  // Entry names of a directory; [] when missing/unreadable.
  listDir(path: string): string[];
  // mtime in ms, or null when the path does not exist.
  statMtimeMs(path: string): number | null;
  // null = connection refused / network error (distinct from any HTTP status).
  fetchUrl(url: string, timeoutMs: number): Promise<HttpResponseSummary | null>;
  // First-frame heuristic (fail-open) — behind the seam so tests can script it.
  isBlankImage(path: string): Promise<BlankImageResult>;
  ephemeralPort(): Promise<number>;
  homeDir(): string;
  sleep(ms: number): Promise<void>;
  now(): number;
};

export type RuntimeContext = {
  workspace: string;
  runId: string;
  evidenceDir: string;
  warmupMs: number;
  keepAlive: boolean;
  // Capture a video of the boot (adapters that can: iOS via simctl
  // recordVideo, Android via adb screenrecord). Evidence kind "video".
  record: boolean;
  // Run Tier-1 agentic UI test after a successful Tier-0 boot.
  // Requires uiModel; skipped silently if absent.
  tier1: boolean;
  uiModel?: UiModelConfig;
  exec: RuntimeExec;
  emit: (message: string) => void;
};

export type CapabilityResult = { ok: true } | { ok: false; reason: string };

export type BootAdapter = {
  platform: RuntimePlatform;
  // Probe host tooling only (is Xcode/adb/go present?). A miss becomes a
  // SKIPPED verdict in the orchestrator — adapters never return skips from boot().
  capabilityProbe(ctx: RuntimeContext): Promise<CapabilityResult>;
  // Provision → launch → observe → teardown. Must tear down in finally paths;
  // honors ctx.keepAlive by leaving the process running.
  boot(ctx: RuntimeContext): Promise<BootVerdict>;
};
