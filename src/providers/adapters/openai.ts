import type { ProviderAdapter } from "./types";

export const openAiAdapter: ProviderAdapter = {
  id: "openai",
  apiKeyEnv: "OPENAI_API_KEY",
  matchBaseUrl: /(?:api\.)?openai\.com/i,
  defaultBaseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-4.1-mini",
  models: [
    "gpt-4.1-mini",
    "gpt-4.1",
    "gpt-5-codex",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    "gpt-5.6-luna",
    "o4-mini",
    "o3-mini",
  ],
  capabilities: {
    toolChoiceRequired: true,
    parallelToolCalls: true,
    jsonMode: true,
    vision: true,
    reasoning: true,
    flattenSchemas: false,
    contextWindow: 128_000,
  },
};
