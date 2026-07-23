import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RunLog {
  ts: string;
  prompt: string;
  provider?: string;
  model: string;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  /** Prompt tokens DeepSeek served from its context cache (billed ~100× cheaper). */
  cachedPromptTokens?: number;
  systemPromptTokens?: number;
  repoMapTokens?: number;
  historyTokens?: number;
  toolResultTokens?: number;
  modelOutputTokens?: number;
  changedFiles: string[];
  blockers: string[];
}

export interface RunCostEstimate {
  provider: string;
  usd: number | null;
  display: string;
  cacheModelKnown: boolean;
  /** What the same run would have cost with zero cache hits, when the split is known. */
  allMissUsd?: number;
  /** Prompt tokens actually billed at the cache-hit rate. */
  cachedTokens?: number;
}

type Pricing = {
  inputPerMillion: number;
  outputPerMillion: number;
  // Cache-HIT input rate. DeepSeek bills prompt tokens it served from its context
  // cache far cheaper than a fresh (cache-miss) read. When the API reports the
  // hit/miss split (prompt_cache_hit_tokens), estimateRunCost prices the cached
  // portion at this rate instead of inputPerMillion.
  cacheHitPerMillion?: number;
  cacheModelKnown?: boolean;
};

export const CACHE_MISS_ESTIMATE_TAG = "[cache-miss estimate]";

// Per-1M-token prices in USD. `inputPerMillion` is the cache-MISS rate;
// `cacheHitPerMillion` is DeepSeek's much cheaper cache-HIT rate. When usage data
// carries the hit/miss split (live runs), the cached prompt tokens are billed at
// the hit rate and the estimate is accurate; without it we fall back to charging
// all prompt tokens at the miss rate (a conservative ceiling).
// V4-Pro reflects DeepSeek's discounted "forever" rate (75% off the original list
// price); V4-Flash is the standard rate. Verified against api-docs.deepseek.com
// pricing, July 2026 (cache-hit: v4-pro $0.003625/M, v4-flash $0.0028/M).
// deepseek-chat / deepseek-reasoner are the deprecated legacy aliases
// (sunset 2026-07-24) kept at their historical prices. Any model can be overridden
// at runtime with TANYA_PRICE_INPUT_PER_MTOK / TANYA_PRICE_OUTPUT_PER_MTOK /
// TANYA_PRICE_CACHE_HIT_PER_MTOK.
const pricingByProviderModel: Record<string, Record<string, Pricing>> = {
  deepseek: {
    "deepseek-v4-pro": { inputPerMillion: 0.435, outputPerMillion: 0.87, cacheHitPerMillion: 0.003625 },
    "deepseek-v4-flash": { inputPerMillion: 0.14, outputPerMillion: 0.28, cacheHitPerMillion: 0.0028 },
    "deepseek-chat": { inputPerMillion: 0.27, outputPerMillion: 1.10 },
    "deepseek-reasoner": { inputPerMillion: 0.55, outputPerMillion: 2.19 },
  },
  kimi: {
    // Pricing per 1M tokens (USD). kimi-k3 + k2.7-code-highspeed: TBD.
    "kimi-k2.7-code": { inputPerMillion: 0.72, outputPerMillion: 3.50 },
    "kimi-k2.6": { inputPerMillion: 0.95, outputPerMillion: 4.0, cacheHitPerMillion: 0.16 },
    "kimi-k2.5": { inputPerMillion: 0.60, outputPerMillion: 3.0, cacheHitPerMillion: 0.10 },
  },
  openai: {
    "gpt-4.1-mini": { inputPerMillion: 0.20, outputPerMillion: 1.00, cacheHitPerMillion: 0.05 },
    "gpt-4.1": { inputPerMillion: 2.00, outputPerMillion: 8.00, cacheHitPerMillion: 0.50 },
    "gpt-5-codex": { inputPerMillion: 3.75, outputPerMillion: 15.00 },
    "gpt-5.4": { inputPerMillion: 2.50, outputPerMillion: 10.00 },
    "gpt-5.4-mini": { inputPerMillion: 2.50, outputPerMillion: 10.00 },
    "gpt-5.5": { inputPerMillion: 3.75, outputPerMillion: 15.00 },
    "gpt-5.6-luna": { inputPerMillion: 3.50, outputPerMillion: 14.00 },
    "o4-mini": { inputPerMillion: 1.10, outputPerMillion: 4.40 },
    "o3-mini": { inputPerMillion: 1.10, outputPerMillion: 4.40 },
  },
  claude: {
    "claude-sonnet-5": { inputPerMillion: 3.00, outputPerMillion: 15.00, cacheHitPerMillion: 0.30 },
    "claude-opus-4-8": { inputPerMillion: 15.00, outputPerMillion: 75.00, cacheHitPerMillion: 1.50 },
    "claude-haiku-4-5-20251001": { inputPerMillion: 0.80, outputPerMillion: 4.00, cacheHitPerMillion: 0.08 },
  },
};

function priceEnvOverride(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

// Resolve pricing for a provider/model, applying TANYA_PRICE_* env overrides on
// top of the built-in table. Returns undefined when the model is unknown and no
// override is set.
export function resolvePricing(provider: string, model: string): Pricing | undefined {
  const base = pricingByProviderModel[provider]?.[model];
  const inputOverride = priceEnvOverride("TANYA_PRICE_INPUT_PER_MTOK");
  const outputOverride = priceEnvOverride("TANYA_PRICE_OUTPUT_PER_MTOK");
  const cacheHitOverride = priceEnvOverride("TANYA_PRICE_CACHE_HIT_PER_MTOK");
  if (inputOverride === undefined && outputOverride === undefined && cacheHitOverride === undefined) return base;
  const cacheHit = cacheHitOverride ?? base?.cacheHitPerMillion;
  return {
    inputPerMillion: inputOverride ?? base?.inputPerMillion ?? 0,
    outputPerMillion: outputOverride ?? base?.outputPerMillion ?? 0,
    ...(cacheHit !== undefined ? { cacheHitPerMillion: cacheHit } : {}),
    ...(base?.cacheModelKnown !== undefined ? { cacheModelKnown: base.cacheModelKnown } : {}),
  };
}

export function readRunLogs(workspace: string, limit?: number): RunLog[] {
  const runsDir = join(workspace, ".tanya", "runs");
  if (!existsSync(runsDir)) return [];

  const files = readdirSync(runsDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .reverse();
  const selected = limit === undefined ? files : files.slice(0, limit);

  return selected.flatMap((file) => {
    try {
      const parsed = JSON.parse(readFileSync(join(runsDir, file), "utf8")) as Partial<RunLog>;
      if (typeof parsed.ts !== "string" || typeof parsed.model !== "string") return [];
      return [{
        ts: parsed.ts,
        prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
        ...(typeof parsed.provider === "string" ? { provider: parsed.provider } : {}),
        model: parsed.model,
        durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : 0,
        promptTokens: typeof parsed.promptTokens === "number" ? parsed.promptTokens : 0,
        completionTokens: typeof parsed.completionTokens === "number" ? parsed.completionTokens : 0,
        ...(typeof parsed.reasoningTokens === "number" ? { reasoningTokens: parsed.reasoningTokens } : {}),
        ...(typeof parsed.cachedPromptTokens === "number" ? { cachedPromptTokens: parsed.cachedPromptTokens } : {}),
        ...(typeof parsed.systemPromptTokens === "number" ? { systemPromptTokens: parsed.systemPromptTokens } : {}),
        ...(typeof parsed.repoMapTokens === "number" ? { repoMapTokens: parsed.repoMapTokens } : {}),
        ...(typeof parsed.historyTokens === "number" ? { historyTokens: parsed.historyTokens } : {}),
        ...(typeof parsed.toolResultTokens === "number" ? { toolResultTokens: parsed.toolResultTokens } : {}),
        ...(typeof parsed.modelOutputTokens === "number" ? { modelOutputTokens: parsed.modelOutputTokens } : {}),
        changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles.filter((file): file is string => typeof file === "string") : [],
        blockers: Array.isArray(parsed.blockers) ? parsed.blockers.filter((blocker): blocker is string => typeof blocker === "string") : [],
      }];
    } catch {
      return [];
    }
  });
}

export function estimateRunCost(log: Pick<RunLog, "provider" | "model" | "promptTokens" | "completionTokens"> & { reasoningTokens?: number; cachedPromptTokens?: number }): RunCostEstimate {
  const provider = normalizeProvider(log.provider, log.model);
  const pricing = resolvePricing(provider, log.model);
  if (!pricing) {
    return { provider, usd: null, display: "pricing unknown", cacheModelKnown: false };
  }

  const outputTokens = log.completionTokens + (log.reasoningTokens ?? 0);
  // Split prompt tokens into cache hits (billed at the discounted rate) and misses.
  // Only when a cache-hit rate is configured AND the caller supplied a hit count;
  // otherwise every prompt token is charged at the miss rate (the old behaviour).
  const cachedTokens = pricing.cacheHitPerMillion !== undefined
    ? Math.min(Math.max(log.cachedPromptTokens ?? 0, 0), log.promptTokens)
    : 0;
  const uncachedPromptTokens = log.promptTokens - cachedTokens;
  const usd = (uncachedPromptTokens / 1_000_000) * pricing.inputPerMillion +
    (cachedTokens / 1_000_000) * (pricing.cacheHitPerMillion ?? pricing.inputPerMillion) +
    (outputTokens / 1_000_000) * pricing.outputPerMillion;
  const cacheModelKnown = pricing.cacheModelKnown ?? false;
  const allMissUsd = (log.promptTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion;
  return {
    provider,
    usd,
    display: formatUsdWithCacheNote(usd, cacheModelKnown),
    cacheModelKnown,
    ...(cachedTokens > 0 ? { allMissUsd, cachedTokens } : {}),
  };
}

export function formatRunLogLine(log: RunLog): string {
  const cost = estimateRunCost(log);
  const status = log.blockers.length > 0 ? "BLOCKED" : "OK";
  const duration = `${Math.round(log.durationMs / 1000)}s`;
  const fileCount = log.changedFiles.length;
  return `${log.ts.slice(0, 16)}  ${status.padEnd(7)} ${duration.padStart(5)}  ${cost.display.padStart(15)}  ${fileCount} file(s)  ${log.prompt.slice(0, 60)}`;
}

export function formatUsd(usd: number): string {
  if (usd < 0.001) return "<$0.001";
  return `$${usd.toFixed(3)}`;
}

export function formatUsdWithCacheNote(usd: number, cacheModelKnown = false): string {
  return cacheModelKnown ? formatUsd(usd) : `${formatUsd(usd)} ${CACHE_MISS_ESTIMATE_TAG}`;
}

function normalizeProvider(provider: string | undefined, model: string): string {
  if (provider?.trim()) return provider.trim();
  if (model.startsWith("deepseek-")) return "deepseek";
  return "unknown";
}
