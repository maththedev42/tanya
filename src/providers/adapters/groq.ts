import type { ProviderAdapter } from "./types";

export const groqAdapter: ProviderAdapter = {
  id: "groq",
  matchBaseUrl: /api\.groq\.com/i,
  defaultBaseUrl: "https://api.groq.com/openai/v1",
  defaultModel: "llama-3.3-70b-versatile",
  models: [
    "llama-3.3-70b-versatile",
    "mixtral-8x7b-32768",
    "gemma2-9b-it",
  ],
  capabilities: {
    toolChoiceRequired: false,
    parallelToolCalls: false,
    jsonMode: true,
    vision: false,
    reasoning: false,
    flattenSchemas: false,
    contextWindow: 131_000,
  },
};
