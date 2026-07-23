import type { ProviderAdapter } from "./types";

export const deepSeekAdapter: ProviderAdapter = {
  id: "deepseek",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  matchBaseUrl: /api\.deepseek\.com/i,
  defaultBaseUrl: "https://api.deepseek.com",
  defaultModel: "deepseek-v4-pro",
  models: [
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-chat",
    "deepseek-reasoner",
  ],
  capabilities: {
    toolChoiceRequired: false,
    parallelToolCalls: false,
    jsonMode: true,
    vision: false,
    reasoning: true,
    roundTripReasoning: true,
    flattenSchemas: false,
    contextWindow: 128_000,
  },
};
