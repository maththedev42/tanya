import { join } from "node:path";
import {
  makeBootCheck,
  makeEvidence,
  type BootCheckResult,
  type BootEvidence,
  type RuntimeContext,
} from "../types";
import { runAgenticUITest } from "./agenticUI";
import { makeScreenOcr } from "./ocr";
import type { InteractDriver, UIVerdict } from "./types";

// Shared Tier-1 hook for device adapters: runs the agentic UI test while the
// app is still alive (callers invoke it inside their try block, before the
// pass return), records the runtime-ui check + report evidence, and hands the
// verdict back so the adapter decides pass/fail. Returns null when Tier-1 is
// not enabled for this run or the host cannot produce a UI tree (skipped,
// never a failure).
export async function maybeRunTier1(
  ctx: RuntimeContext,
  platform: "ios" | "android",
  makeDriver: () => Promise<InteractDriver> | InteractDriver,
  checks: BootCheckResult[],
  evidence: BootEvidence[],
): Promise<UIVerdict | null> {
  if (!ctx.tier1 || !ctx.uiModel) return null;
  ctx.emit("starting Tier-1 agentic UI test");
  const driver = await makeDriver();
  const initialTree = await driver.describeUi();
  if (initialTree === null) {
    const reason =
      platform === "ios"
        ? "UI tree unavailable — install idb (pipx install fb-idb + brew tap facebook/fb && brew install idb-companion) for interactive iOS testing"
        : "UI tree unavailable (uiautomator dump failed)";
    ctx.emit(`Tier-1 skipped: ${reason}`);
    checks.push(
      makeBootCheck({ id: "runtime-ui", description: "agentic UI test", passed: true, skipped: true, detail: reason }),
    );
    return null;
  }
  const ui = await runAgenticUITest({
    exec: ctx.exec,
    workspace: ctx.workspace,
    driver,
    evidenceDir: ctx.evidenceDir,
    uiModel: ctx.uiModel,
    platform,
    initialTree,
    // On-device OCR gives the agent the literal on-screen text so it catches
    // visual-only bugs the accessibility tree hides. Self-disables (fail-open)
    // if the host has no Swift toolchain.
    ocr: makeScreenOcr(ctx.exec),
    emit: ctx.emit,
  });
  const detail = ui.issues.length > 0 ? ui.issues.join("; ") : undefined;
  checks.push(
    makeBootCheck({
      id: "runtime-ui",
      description: ui.appDescription ? `agentic UI — ${ui.appDescription}` : "agentic UI test",
      passed: ui.passed,
      ...(detail !== undefined ? { detail } : {}),
    }),
  );
  const reportPath = join(ctx.evidenceDir, "ui-report.md");
  if (ctx.exec.fileExists(reportPath)) {
    evidence.push(makeEvidence("log", { path: reportPath, excerpt: ui.summary }));
  }
  return ui;
}
