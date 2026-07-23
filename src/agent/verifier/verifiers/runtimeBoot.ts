import { envValue } from "../../../config/envCompat";
import { runBootTest } from "../../../runtime";
import { bootVerdictToChecks } from "../../../runtime/manifest";
import { resolveUiModelConfig } from "../../../runtime/uiModel";
import { makeCheck, type Verifier } from "../types";

function flagOn(metadataValue: unknown, envName: string): boolean {
  if (metadataValue === true || metadataValue === "true" || metadataValue === 1) return true;
  return /^(1|true|yes|on)$/i.test(envValue(process.env, envName).trim());
}

// Tier-0 runtime boot test as a ring of the final-state verify chain.
//
// Strictly OPT-IN: booting apps (simulators, dev servers, gradle) is far too
// heavy to run on every coding task, so this only activates when the caller
// asked for it via `tanya run --runtime-check` (-> metadata.runtimeCheck) or
// TANYA_RUNTIME_CHECK=1. The headless `tanya test-app` command is the primary
// surface; this verifier folds the same harness into TANYA RESULT for callers
// that want one combined verdict.
//
// Tier-1 (agentic UI test) joins the ring via `--tier1` / TANYA_TIER1 — UI
// issues become authoritative failed checks, so the run-loop agent sees them
// as blockers, fixes the app, and re-verifies before TANYA RESULT can pass.
export const runtimeBootVerifier: Verifier = {
  id: "runtime-boot",
  platform: "generic",
  appliesTo(ctx) {
    return (
      flagOn(ctx.runContext?.metadata?.runtimeCheck, "TANYA_RUNTIME_CHECK") ||
      flagOn(ctx.runContext?.metadata?.tier1, "TANYA_TIER1")
    );
  },
  async run(ctx) {
    // The test runner must never boot real apps through the verify chain.
    if (process.env.VITEST === "true" || process.env.VITEST === "1") {
      return [
        makeCheck({
          id: "runtime-boot",
          description: "runtime boot test",
          passed: true,
          authoritative: false,
          skipped: true,
          evidence: "skipped under the test runner",
        }),
      ];
    }
    // Uses the full runtime exec (long-running launches, HTTP, screenshots) —
    // the verifier ctx.shell is run-to-completion only and too narrow here.
    const tier1Wanted = flagOn(ctx.runContext?.metadata?.tier1, "TANYA_TIER1");
    const uiModel = tier1Wanted ? resolveUiModelConfig() : undefined;
    const tier1 = tier1Wanted && uiModel !== undefined;
    const verdict = await runBootTest({
      workspace: ctx.workspace,
      tier1,
      // Tier-1 sessions are recorded so the fix loop (and the user) can watch
      // what the UI agent saw.
      record: tier1,
      ...(uiModel !== undefined ? { uiModel } : {}),
    });
    const checks = bootVerdictToChecks(verdict);
    if (tier1Wanted && !tier1) {
      checks.push(
        makeCheck({
          id: "runtime-ui",
          description: "agentic UI test",
          passed: true,
          authoritative: false,
          skipped: true,
          evidence: "tier1 requested but no model key is set (DEEPSEEK_API_KEY / TANYA_API_KEY) — UI test skipped",
        }),
      );
    }
    return checks;
  },
};
