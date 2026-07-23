import type { ProviderAdapter } from "./types";
import { withoutUnsupportedToolChoice } from "./types";

export const grokAdapter: ProviderAdapter = {
  id: "grok",
  matchBaseUrl: /(?:api\.)?x\.ai/i,
  defaultBaseUrl: "https://api.x.ai/v1",
  defaultModel: "grok-3-mini",
  models: [
    "grok-3-mini",
    "grok-3",
    "grok-3-beta",
  ],
  capabilities: {
    toolChoiceRequired: false,
    parallelToolCalls: false,
    jsonMode: true,
    vision: true,
    reasoning: true,
    flattenSchemas: false,
    contextWindow: 131_000,
  },
  preRequest: withoutUnsupportedToolChoice,
};
