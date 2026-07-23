import type { ProviderAdapter } from "./types";

export const claudeAdapter: ProviderAdapter = {
  id: "claude",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  matchBaseUrl: /api\.anthropic\.com/i,
  defaultBaseUrl: "https://api.anthropic.com/v1",
  defaultModel: "claude-sonnet-5",
  models: [
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-haiku-4-5-20251001",
  ],
  capabilities: {
    toolChoiceRequired: true,
    parallelToolCalls: true,
    jsonMode: false,
    vision: true,
    reasoning: true,
    roundTripReasoning: false,
    flattenSchemas: false,
    contextWindow: 200_000,
  },
};
