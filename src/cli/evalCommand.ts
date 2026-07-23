import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config/env";
import { createProvider } from "../providers/factory";
import { migrateLegacyDotDir } from "../init/migrateDotDir";
import { dryRunEvalSuite, loadEvalSuite } from "../eval/suites";
import { parseTaskFilter, readEvalResult, runEvalSuite, writeEvalResult } from "../eval/runner";
import { formatEvalReport } from "../eval/report";
import { compareEvalResults, formatEvalComparison } from "../eval/compare";
import { flagNumber, flagString, flagStrings, hasFlag, type ParsedArgs } from "./args";

export async function runEvalCommand(args: ParsedArgs): Promise<void> {
  const cwd = resolve(flagString(args, "cwd") ?? process.cwd());
  migrateLegacyDotDir(cwd);
  const action = args.positional[0];
  const format = flagStrings(args, "format").includes("markdown") ? "markdown" : "text";
  if (action === "report") {
    const file = args.positional[1];
    if (!file) throw new Error("Usage: tanya eval report <result.json> [--format markdown]");
    process.stdout.write(formatEvalReport(await readEvalResult(resolve(cwd, file)), format));
    return;
  }
  if (action === "compare") {
    const baseline = args.positional[1];
    const next = args.positional[2];
    if (!baseline || !next) throw new Error("Usage: tanya eval compare <baseline.json> <new.json> [--format markdown]");
    const comparison = compareEvalResults(
      await readEvalResult(resolve(cwd, baseline)),
      await readEvalResult(resolve(cwd, next)),
      flagNumber(args, "cost-regression-threshold") ?? 0.20,
    );
    process.stdout.write(formatEvalComparison(comparison, format));
    if (comparison.regressions.length > 0) process.exitCode = 1;
    return;
  }
  const suiteName = flagString(args, "suite") ?? args.positional[0] ?? "tanya-native";
  const suite = loadEvalSuite(suiteName);
  const modelFlag = flagString(args, "model");
  const modelParts = modelFlag?.includes("/") ? modelFlag.split("/") : undefined;
  const providerName = modelParts?.[0] ?? flagString(args, "provider");
  const modelName = modelParts?.[1] ?? modelFlag;
  const config = hasFlag(args, "dry-run") && providerName && modelName
    ? undefined
    : loadConfig(cwd);
  const provider = providerName ?? config?.provider ?? "deepseek";
  const model = modelName ?? config?.model ?? "deepseek-chat";
  if (hasFlag(args, "dry-run")) {
    const dryRun = dryRunEvalSuite(suite, provider, model);
    if (hasFlag(args, "json")) {
      process.stdout.write(`${JSON.stringify(dryRun, null, 2)}\n`);
    } else {
      process.stdout.write(`Eval dry-run: ${dryRun.suite}@${dryRun.suiteVersion}\n`);
      process.stdout.write(`Tasks: ${dryRun.taskCount}\n`);
      process.stdout.write(`Model: ${provider}/${model}\n`);
      process.stdout.write(`Estimated cost: ${dryRun.estimatedCostUsd === null ? "pricing unknown" : `$${dryRun.estimatedCostUsd.toFixed(3)}`}\n`);
    }
    return;
  }

  process.env.TANYA_PROVIDER = provider;
  process.env.TANYA_MODEL = model;
  const evalConfig = loadConfig(cwd);
  const taskIds = parseTaskFilter(flagString(args, "task"));
  const parallel = flagNumber(args, "parallel");
  const result = await runEvalSuite(suite, {
    cwd,
    provider,
    model,
    tanyaVersion: JSON.parse(readFileSync(resolve("package.json"), "utf8")).version,
    ...(taskIds ? { taskIds } : {}),
    ...(parallel !== undefined ? { parallel } : {}),
    providerFactory: () => createProvider(evalConfig),
  });
  const out = flagString(args, "out");
  if (out) {
    await writeEvalResult(resolve(cwd, out), result);
    process.stdout.write(`Wrote eval result to ${resolve(cwd, out)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
