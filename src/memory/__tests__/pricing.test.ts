import { afterEach, describe, expect, it } from "vitest";
import { estimateRunCost, resolvePricing } from "../runLogs";

const ENV_KEYS = ["TANYA_PRICE_INPUT_PER_MTOK", "TANYA_PRICE_OUTPUT_PER_MTOK", "TANYA_PRICE_CACHE_HIT_PER_MTOK"];

function clearPriceEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("resolvePricing", () => {
  afterEach(clearPriceEnv);

  it("prices deepseek-v4-pro at the discounted forever rate", () => {
    expect(resolvePricing("deepseek", "deepseek-v4-pro")).toEqual({ inputPerMillion: 0.435, outputPerMillion: 0.87, cacheHitPerMillion: 0.003625 });
  });

  it("prices deepseek-v4-flash at the standard rate", () => {
    expect(resolvePricing("deepseek", "deepseek-v4-flash")).toEqual({ inputPerMillion: 0.14, outputPerMillion: 0.28, cacheHitPerMillion: 0.0028 });
  });

  it("returns undefined for an unknown model with no override", () => {
    expect(resolvePricing("deepseek", "made-up-model")).toBeUndefined();
    expect(resolvePricing("openai", "gpt-4")).toBeUndefined();
  });

  it("applies TANYA_PRICE_* env overrides on top of the table", () => {
    process.env.TANYA_PRICE_INPUT_PER_MTOK = "1.5";
    process.env.TANYA_PRICE_OUTPUT_PER_MTOK = "3";
    // input/output are overridden; the built-in cache-hit rate carries through.
    expect(resolvePricing("deepseek", "deepseek-v4-pro")).toEqual({ inputPerMillion: 1.5, outputPerMillion: 3, cacheHitPerMillion: 0.003625 });
  });

  it("overrides the cache-hit rate with TANYA_PRICE_CACHE_HIT_PER_MTOK", () => {
    process.env.TANYA_PRICE_CACHE_HIT_PER_MTOK = "0.01";
    expect(resolvePricing("deepseek", "deepseek-v4-pro")).toEqual({ inputPerMillion: 0.435, outputPerMillion: 0.87, cacheHitPerMillion: 0.01 });
  });

  it("lets an override price a model that has no built-in entry", () => {
    process.env.TANYA_PRICE_INPUT_PER_MTOK = "0.2";
    process.env.TANYA_PRICE_OUTPUT_PER_MTOK = "0.6";
    expect(resolvePricing("deepseek", "future-model")).toEqual({ inputPerMillion: 0.2, outputPerMillion: 0.6 });
  });

  it("ignores invalid override values", () => {
    process.env.TANYA_PRICE_INPUT_PER_MTOK = "not-a-number";
    expect(resolvePricing("deepseek", "deepseek-v4-pro")).toEqual({ inputPerMillion: 0.435, outputPerMillion: 0.87, cacheHitPerMillion: 0.003625 });
  });

  it("prices the kimi models from the per-provider table", () => {
    expect(resolvePricing("kimi", "kimi-k2.7-code")).toEqual({ inputPerMillion: 0.72, outputPerMillion: 3.5 });
    expect(resolvePricing("kimi", "kimi-k2.6")).toEqual({ inputPerMillion: 0.95, outputPerMillion: 4.0, cacheHitPerMillion: 0.16 });
    expect(resolvePricing("kimi", "kimi-k2.5")).toEqual({ inputPerMillion: 0.6, outputPerMillion: 3.0, cacheHitPerMillion: 0.1 });
  });

  it("returns undefined for kimi-k3 until its price is verified", () => {
    // Deliberate: k3/k2.7-code-highspeed pricing is a VERIFY-AT-BUILD item in
    // KIMI_PROVIDER_PLAN.md. An unknown model must fall through to undefined
    // (cost lines are skipped) rather than get a guessed rate.
    expect(resolvePricing("kimi", "kimi-k3")).toBeUndefined();
  });

  it("prices claude models from the per-provider table", () => {
    expect(resolvePricing("claude", "claude-sonnet-5")).toEqual({ inputPerMillion: 3.00, outputPerMillion: 15.00, cacheHitPerMillion: 0.30 });
    expect(resolvePricing("claude", "claude-opus-4-8")).toEqual({ inputPerMillion: 15.00, outputPerMillion: 75.00, cacheHitPerMillion: 1.50 });
    expect(resolvePricing("claude", "claude-haiku-4-5-20251001")).toEqual({ inputPerMillion: 0.80, outputPerMillion: 4.00, cacheHitPerMillion: 0.08 });
  });

  it("prices openai models from the per-provider table", () => {
    expect(resolvePricing("openai", "gpt-4.1-mini")).toBeDefined();
    expect(resolvePricing("openai", "gpt-4.1")).toBeDefined();
    expect(resolvePricing("openai", "gpt-5-codex")).toBeDefined();
  });
});

describe("estimateRunCost with v4-pro", () => {
  afterEach(clearPriceEnv);

  it("computes USD from prompt + completion + reasoning tokens", () => {
    const cost = estimateRunCost({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      promptTokens: 1_000_000,
      completionTokens: 500_000,
      reasoningTokens: 500_000,
    });
    // input: 1M * 0.435 = 0.435 ; output: (0.5M+0.5M) * 0.87 = 0.87 ; total 1.305
    expect(cost.usd).toBeCloseTo(1.305, 5);
  });

  it("honours an env override end-to-end", () => {
    process.env.TANYA_PRICE_INPUT_PER_MTOK = "1";
    process.env.TANYA_PRICE_OUTPUT_PER_MTOK = "2";
    const cost = estimateRunCost({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(cost.usd).toBeCloseTo(3, 5); // 1*1 + 1*2
  });

  it("bills cache-hit prompt tokens at the discounted rate", () => {
    const cost = estimateRunCost({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      promptTokens: 1_000_000,
      cachedPromptTokens: 900_000, // 90% served from cache
      completionTokens: 0,
    });
    // 100k miss * 0.435/M + 900k hit * 0.003625/M = 0.0435 + 0.0032625 = 0.0467625
    expect(cost.usd).toBeCloseTo(0.0467625, 6);
  });

  it("without a cache-hit count, charges every prompt token at the miss rate (ceiling)", () => {
    const cost = estimateRunCost({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      promptTokens: 1_000_000,
      completionTokens: 0,
    });
    expect(cost.usd).toBeCloseTo(0.435, 6);
  });

  it("clamps a cache-hit count that exceeds prompt tokens", () => {
    const cost = estimateRunCost({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      promptTokens: 100_000,
      cachedPromptTokens: 999_999, // bogus over-count
      completionTokens: 0,
    });
    // all 100k treated as hits: 100k * 0.003625/M = 0.0003625
    expect(cost.usd).toBeCloseTo(0.0003625, 7);
  });
});
