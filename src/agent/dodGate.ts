// Definition-of-done runtime gate.
//
// "It compiled" is not "it works". The calculator built and launched but every
// digit button rendered "\(n)" and 2 + 2 showed 22 — pure behavioural failures
// a build check can never catch. This gate closes that gap WITHOUT re-opening
// the long false-FAIL wound (a green build must never be failed for lack of
// proof). The contract is self-clearing:
//
//   app works + runtime-tested   -> no signal            -> PASS
//   app works, not yet tested    -> `unverified` nudge   -> agent runs the test -> PASS
//   host can't run the app       -> SKIP verdict         -> PASS
//   app is actually broken       -> `behavior failed:` blocker -> FAIL -> repair loop
//
// Only a real, observed runtime failure gates. "Not yet verified" is a nudge to
// run `tanya test-app`, never a verdict — so a working app can never false-FAIL.

import { readdir, readFile, stat } from "node:fs/promises";
import { offFlag } from "../config/runtimeFlags";
import { join } from "node:path";
import { extractAcceptanceCriteria, type AcceptanceCriterion } from "./acceptanceCriteria";

export interface RuntimeEvidence {
  status: "pass" | "fail" | "skip";
  reason: string;
}

export interface DodAssessment {
  // Gating failures (real, observed runtime failures). Merged into manifest.blockers.
  blockers: string[];
  // Behaviour was never exercised. A non-gating nudge to run the runtime test.
  unverified: boolean;
  unverifiedReason?: string;
}

// The criteria the build alone can never prove — everything beyond "it compiled
// and launched". These are exactly the cases where a runtime check earns its keep.
export function behavioralCriteria(prompt: string): AcceptanceCriterion[] {
  return extractAcceptanceCriteria(prompt).filter((criterion) => criterion.id !== "builds-and-launches");
}

// Escape hatch: TANYA_DOD_GATE=0|false|off|no disables the runtime gate entirely.
export function dodRuntimeGateEnabled(): boolean {
  return offFlag("TANYA_DOD_GATE");
}

export function requiresRuntimeVerification(prompt: string, isCoding: boolean): boolean {
  return isCoding && dodRuntimeGateEnabled() && behavioralCriteria(prompt).length > 0;
}

// Reads the freshest `tanya test-app` verdict written during THIS run. Scans
// `.tanya/runtime/<runId>/verdict.json` and ignores any verdict older than the
// run's start (so a stale verdict from a previous run can never clear the gate).
// Fail-open: any read/parse error yields null (treated as "not yet verified").
export async function readLatestRuntimeVerdict(
  workspace: string,
  sinceMs: number,
): Promise<RuntimeEvidence | null> {
  const runtimeDir = join(workspace, ".tanya", "runtime");
  let entries: string[];
  try {
    entries = await readdir(runtimeDir);
  } catch {
    return null;
  }
  let best: { mtimeMs: number; status: RuntimeEvidence["status"]; reason: string } | null = null;
  for (const entry of entries) {
    const verdictPath = join(runtimeDir, entry, "verdict.json");
    try {
      const fileStat = await stat(verdictPath);
      if (fileStat.mtimeMs < sinceMs) continue;
      if (best && fileStat.mtimeMs <= best.mtimeMs) continue;
      const parsed = JSON.parse(await readFile(verdictPath, "utf8")) as { status?: unknown; reason?: unknown };
      const status = parsed.status;
      if (status !== "pass" && status !== "fail" && status !== "skipped") continue;
      best = {
        mtimeMs: fileStat.mtimeMs,
        status: status === "skipped" ? "skip" : status,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
      };
    } catch {
      // Missing/unreadable/non-JSON verdict — skip it, never throw.
    }
  }
  return best ? { status: best.status, reason: best.reason } : null;
}

export async function runtimeDodAssessment(params: {
  prompt: string;
  isCoding: boolean;
  workspace: string;
  sinceMs: number;
}): Promise<DodAssessment> {
  if (!requiresRuntimeVerification(params.prompt, params.isCoding)) {
    return { blockers: [], unverified: false };
  }
  const evidence = await readLatestRuntimeVerdict(params.workspace, params.sinceMs);
  if (evidence?.status === "fail") {
    const reason = evidence.reason.trim() || "the running app failed its runtime check";
    return {
      blockers: [
        `behavior failed: ${reason} — run \`tanya test-app --tier1\`, fix the reported issues, and re-test until it passes`,
      ],
      unverified: false,
    };
  }
  // A pass OR a skip means the behaviour was actually exercised (or genuinely
  // cannot be on this host) — either way it clears, never gates.
  if (evidence) {
    return { blockers: [], unverified: false };
  }
  // No runtime evidence at all: not a failure, but not yet proven. Nudge only.
  const summary = behavioralCriteria(params.prompt).map((criterion) => criterion.text).join(" ");
  return {
    blockers: [],
    unverified: true,
    ...(summary ? { unverifiedReason: summary } : {}),
  };
}
