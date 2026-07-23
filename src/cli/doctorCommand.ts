import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, type TanyaConfig } from "../config/env";
import { migrateLegacyDotDir } from "../init/migrateDotDir";
import { flagString, hasFlag, type ParsedArgs } from "./args";

async function runLegacySetupDoctor(cwd: string, asJson: boolean): Promise<void> {
  migrateLegacyDotDir(cwd);
  const checks: Array<{ name: string; status: "ok" | "warn" | "fail"; detail: string }> = [];
  const doOk = (name: string, detail: string) => checks.push({ name, status: "ok", detail });
  const doWarn = (name: string, detail: string) => checks.push({ name, status: "warn", detail });
  const doFail = (name: string, detail: string) => checks.push({ name, status: "fail", detail });

  // Node + runtime
  const major = Number(process.version.replace(/^v/, "").split(".")[0] ?? "0");
  if (major >= 20) doOk("node", `${process.version}`);
  else doFail("node", `${process.version} — tanya requires Node 20+`);

  // Provider config — never let a missing key throw out of doctor; report it.
  let config: TanyaConfig | null = null;
  try {
    config = loadConfig(cwd);
  } catch (error) {
    doFail("provider.config", error instanceof Error ? error.message : String(error));
  }
  if (config) {
    if (config.apiKey) doOk("provider.apiKey", "present");
    else doFail("provider.apiKey", "missing — set TANYA_API_KEY or DEEPSEEK_API_KEY");
    if (config.baseUrl) doOk("provider.baseUrl", config.baseUrl);
    else doFail("provider.baseUrl", "missing — set TANYA_BASE_URL");
    doOk("provider.model", `${config.provider}:${config.model} (profile=${config.profile})`);
    doOk("provider.timeoutMs", `${config.timeoutMs}ms`);
  }

  // Workspace
  const cwdHasGit = existsSync(join(cwd, ".git"));
  if (cwdHasGit) doOk("workspace.git", `${cwd}`);
  else doWarn("workspace.git", `${cwd} is not a git repository — stash/retry recovery will be disabled`);
  const cwdHasArtifacts = existsSync(join(cwd, "artifacts"));
  if (cwdHasArtifacts) doOk("workspace.artifacts", `${join(cwd, "artifacts")} (auto-detected)`);
  else doWarn("workspace.artifacts", "no ./artifacts dir — pass --artifacts-root or run from a project that has one");

  // Project-level forbidden patterns
  const fpPath = join(cwd, ".tanya", "forbidden-patterns.json");
  if (existsSync(fpPath)) {
    try {
      const raw = readFileSync(fpPath, "utf8");
      const parsed = JSON.parse(raw);
      const count = Array.isArray(parsed?.patterns) ? parsed.patterns.length : 0;
      doOk("workspace.forbiddenPatterns", `${count} project pattern(s) loaded from ${fpPath}`);
    } catch (err) {
      doFail("workspace.forbiddenPatterns", `${fpPath} exists but is invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    doOk("workspace.forbiddenPatterns", "no project overrides (using defaults)");
  }

  // Forbidden-pattern fire metrics (from accumulated runs)
  const fpMetricsPath = join(cwd, ".tanya", "memory", "forbidden-patterns-metrics.json");
  if (existsSync(fpMetricsPath)) {
    try {
      const raw = readFileSync(fpMetricsPath, "utf8");
      const parsed = JSON.parse(raw) as { totals?: Record<string, number>; totalScans?: number };
      const totals = parsed.totals ?? {};
      const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (top.length > 0) {
        const summary = top.map(([id, n]) => `${id}=${n}`).join(", ");
        doOk("workspace.forbiddenPatterns.metrics", `top fires across ${parsed.totalScans ?? 0} scans: ${summary}`);
      } else {
        doOk("workspace.forbiddenPatterns.metrics", `no patterns ever fired (${parsed.totalScans ?? 0} scans)`);
      }
    } catch {
      doWarn("workspace.forbiddenPatterns.metrics", `${fpMetricsPath} exists but is unreadable`);
    }
  } else {
    doOk("workspace.forbiddenPatterns.metrics", "no metrics yet (no scans recorded)");
  }

  // Obsidian vault
  if (config?.obsidianVault) {
    if (existsSync(config.obsidianVault)) doOk("obsidian.vault", config.obsidianVault);
    else doWarn("obsidian.vault", `${config.obsidianVault} configured but path does not exist`);
  } else {
    doOk("obsidian.vault", "not configured (optional)");
  }

  // ffmpeg presence (informational; only required for tanya video)
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    doOk("ffmpeg", "available (tanya video commands enabled)");
  } catch {
    doWarn("ffmpeg", "not found on PATH — tanya video commands will fail until installed");
  }

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;

  if (asJson) {
    process.stdout.write(`${JSON.stringify({
      cwd,
      checks,
      summary: { ok: checks.length - failed - warned, warn: warned, fail: failed },
    })}\n`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  // Render
  console.log(`Tanya doctor — ${cwd}`);
  console.log("");
  for (const check of checks) {
    const tag = check.status === "ok" ? "[ok]  " : check.status === "warn" ? "[warn]" : "[FAIL]";
    console.log(`${tag} ${check.name.padEnd(28)} ${check.detail}`);
  }
  console.log("");
  console.log(`Summary: ${checks.length - failed - warned} ok, ${warned} warn, ${failed} fail`);
  if (failed > 0) process.exitCode = 1;
}

export async function doctor(args?: ParsedArgs): Promise<void> {
  const cwd = resolve(args ? flagString(args, "cwd") ?? process.cwd() : process.cwd());
  const runId = args ? flagString(args, "run") : undefined;
  const asJson = args ? hasFlag(args, "json") : false;
  const list = args ? hasFlag(args, "list") : false;

  // --json mode: keep legacy setup-doctor behaviour (machine-readable)
  if (asJson) {
    await runLegacySetupDoctor(cwd, true);
    return;
  }

  // Import doctor dynamically so it doesn't add startup cost to other commands.
  const { runDoctor, ledgerSummary } = await import("../agent/doctor/index.js");

  // --list mode: print ledger summary and exit
  if (list) {
    console.log(ledgerSummary(cwd));
    return;
  }

  const diagnosis = runDoctor({ ...(runId ? { runId } : {}), cwd });

  // Nothing to diagnose (healthy repo): fall through to the setup checks.
  if (diagnosis.classes.length === 0) {
    console.log(diagnosis.explanation);
    console.log("");
    await runLegacySetupDoctor(cwd, false);
    return;
  }

  // Print the diagnosis to stdout
  console.log(diagnosis.explanation);
  console.log("");
  console.log("---");
  console.log("");
  console.log("## Ready-to-dispatch repair prompt");
  console.log("");
  console.log(`Saved to: .tanya/doctor/${diagnosis.runId}-repair-prompt.md`);
  console.log("");
  console.log(diagnosis.repairPrompt);

  if (!diagnosis.classes.includes("unknown")) {
    console.log("");
    console.log(`Diagnosis: ${diagnosis.classes.join(", ")}`);
    return;
  }

  // Unknown class: an unclassified failure sometimes traces back to a broken
  // local setup — run the legacy setup checks too.
  console.log("");
  await runLegacySetupDoctor(cwd, false);
}
