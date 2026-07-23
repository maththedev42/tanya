import type { ProviderAdapter } from "./types";
import { withoutUnsupportedToolChoice } from "./types";

export const kimiAdapter: ProviderAdapter = {
  id: "kimi",
  apiKeyEnv: "KIMI_API_KEY",
  matchBaseUrl: /api\.moonshot\.(ai|cn)|\.kimi\./i,
  defaultBaseUrl: "https://api.moonshot.ai/v1",
  defaultModel: "kimi-k2.7-code",
  models: [
    "kimi-k2.7-code",
    "kimi-k2.7-code-highspeed",
    "kimi-k2.6",
    "kimi-k3",
  ],
  capabilities: {
    toolChoiceRequired: false,
    parallelToolCalls: false,
    jsonMode: true,
    vision: true,
    reasoning: true,
    roundTripReasoning: true,
    flattenSchemas: false,
    contextWindow: 256_000,
  },
  preRequest: (req) => {
    // temperature/top_p are FIXED server-side on k3/k2.7/k2.6 — never send them.
    const { temperature: _t, top_p: _p, ...rest } = withoutUnsupportedToolChoice(req);
    return rest;
  },
};
