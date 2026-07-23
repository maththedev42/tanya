import { loadConfig } from "../../config/env";
import { estimateRunCost, formatUsd, formatUsdWithCacheNote, readRunLogs } from "../../memory/runLogs";
import { fetchDeepSeekBalance, formatBalanceLine } from "../../providers/deepseekBalance";
import { fetchKimiBalance, formatKimiBalanceLine } from "../../providers/kimiBalance";
import { appendProjectSpendRule } from "../../safety/permissions/config";
import { registerCommand } from "../registry";
import type { CommandDefinition } from "../registry";

const costCommand: CommandDefinition = {
  name: "cost",
  description: "Show token usage, cache hit-rate, and estimated run costs.",
  category: "built-in",
  async handler(args, ctx) {
    if (args.includes("--enforce")) {
      const maxUsd = parsePositiveNumber(flagValue(args, "--max-usd"));
      const maxTokens = parsePositiveNumber(flagValue(args, "--max-tokens"));
      if (maxUsd === undefined && maxTokens === undefined) {
        ctx.output.write("Usage: /cost --enforce --max-usd <amount> [--max-tokens <count>]\n");
        return;
      }
      const path = appendProjectSpendRule(ctx.cwd, {
        type: "spend",
        scope: "session",
        ...(maxUsd !== undefined ? { max_usd: maxUsd } : {}),
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        action: "deny",
      });
      ctx.output.write(`Session spend rule written to ${path}\n`);
      return;
    }

    const logs = readRunLogs(ctx.cwd);
    if (logs.length === 0) {
      ctx.output.write("No run logs found. Run tanya run first.\n");
      return;
    }

    let knownTotal = 0;
    let unknownCount = 0;
    let hasCacheMissEstimate = false;
    let promptTokensWithCacheData = 0;
    let cachedTokensTotal = 0;
    let cacheSavingsTotal = 0;
    ctx.output.write("Recent run costs:\n");
    for (const log of logs) {
      const estimate = estimateRunCost(log);
      if (estimate.usd === null) {
        unknownCount += 1;
      } else {
        knownTotal += estimate.usd;
        hasCacheMissEstimate ||= !estimate.cacheModelKnown;
      }
      const reasoning = log.reasoningTokens ?? 0;
      let cacheNote = "";
      if (estimate.cachedTokens !== undefined && log.promptTokens > 0) {
        promptTokensWithCacheData += log.promptTokens;
        cachedTokensTotal += estimate.cachedTokens;
        if (estimate.allMissUsd !== undefined && estimate.usd !== null) {
          cacheSavingsTotal += Math.max(0, estimate.allMissUsd - estimate.usd);
        }
        cacheNote = `  cache ${Math.round((estimate.cachedTokens / log.promptTokens) * 100)}%`;
      }
      ctx.output.write(
        `${log.ts.slice(0, 16)}  ${estimate.provider}:${log.model}  ${log.promptTokens.toLocaleString("en-US")} in / ${log.completionTokens.toLocaleString("en-US")} out / ${reasoning.toLocaleString("en-US")} reasoning${cacheNote}  ${estimate.display}\n`,
      );
    }
    ctx.output.write(`Session total: ${formatUsdWithCacheNote(knownTotal, !hasCacheMissEstimate)}${unknownCount > 0 ? ` (${unknownCount} run${unknownCount === 1 ? "" : "s"} pricing unknown)` : ""}\n`);
    if (promptTokensWithCacheData > 0) {
      const hitRate = Math.round((cachedTokensTotal / promptTokensWithCacheData) * 100);
      ctx.output.write(
        `Cache: ${cachedTokensTotal.toLocaleString("en-US")} of ${promptTokensWithCacheData.toLocaleString("en-US")} prompt tokens served from cache (${hitRate}%), saving ~${formatUsd(cacheSavingsTotal)} vs all-miss\n`,
      );
    }
    await writeBalanceLine(ctx.cwd, ctx.output);
  },
};

// Real account balance next to the estimates, so drift is visible. Best-effort:
// non-supported providers, a missing key, or a slow network just skip the line.
async function writeBalanceLine(cwd: string, output: NodeJS.WritableStream): Promise<void> {
  try {
    const config = loadConfig(cwd);
    if (config.provider === "deepseek") {
      const balance = await fetchDeepSeekBalance({ apiKey: config.apiKey, baseUrl: config.baseUrl });
      if (balance) output.write(`${formatBalanceLine(balance)}\n`);
    } else if (config.provider === "kimi") {
      const balance = await fetchKimiBalance({ apiKey: config.apiKey, baseUrl: config.baseUrl });
      if (balance) output.write(`${formatKimiBalanceLine(balance)}\n`);
    }
  } catch {
    // loadConfig throws without an API key — balance is optional either way.
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function parsePositiveNumber(raw: string | undefined): number | undefined {
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

registerCommand(costCommand);
