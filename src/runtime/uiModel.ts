import { envValue } from "../config/envCompat";
import type { UiModelConfig } from "./tier1/types";

// The Tier-1 UI agent reads the accessibility tree as TEXT, so it runs on
// Tanya's own DeepSeek credentials by default — no vision model, no extra
// key. Any OpenAI-compatible endpoint works via the TANYA_UI_* overrides
// (e.g. a local Ollama, or a stronger model for hard apps).

export const DEFAULT_UI_MODEL = "deepseek-v4-flash";
export const DEFAULT_UI_BASE_URL = "https://api.deepseek.com";

export function resolveUiModelConfig(
  local: Record<string, string | undefined> = {},
): UiModelConfig | undefined {
  const apiKey =
    envValue(local, "TANYA_UI_API_KEY") ||
    envValue(local, "DEEPSEEK_API_KEY") ||
    envValue(local, "TANYA_API_KEY");
  if (!apiKey.trim()) return undefined;
  const baseUrl =
    envValue(local, "TANYA_UI_BASE_URL") ||
    envValue(local, "DEEPSEEK_BASE_URL") ||
    envValue(local, "TANYA_BASE_URL") ||
    DEFAULT_UI_BASE_URL;
  const model = envValue(local, "TANYA_UI_MODEL").trim() || DEFAULT_UI_MODEL;
  return { apiKey, baseUrl: baseUrl.replace(/\/$/, ""), model };
}
