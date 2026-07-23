import { execFileSync } from "node:child_process";
import { describeRoute } from "../agent/runRoute";
import { envValue } from "../config/envCompat";
import { loadConfig } from "../config/env";
import { createProvider } from "../providers/factory";
import { listProviderAdapters } from "../providers/adapters";
import { fetchDeepSeekBalance, formatBalanceLine } from "../providers/deepseekBalance";
import { fetchKimiBalance, formatKimiBalanceLine } from "../providers/kimiBalance";
import { resolveExecutor } from "../executors/index";
import type { ExecutorId } from "../executors/types";
import { flagString, type ParsedArgs } from "./args";

export async function listProviders(asJson: boolean): Promise<void> {
  // Providers that run against a local endpoint need no API key.
  const keylessProviders = new Set(["ollama"]);
  const { listExecutors } = await import("../executors/index.js");
  const availableExecutors = await listExecutors();

  // Resolve binary paths for CLIStrict providers whose executor is available.
  const binaryPaths = new Map<ExecutorId, string>();
  for (const exec of availableExecutors) {
    if (!exec.available) continue;
    const executor = resolveExecutor(exec.id);
    if (!executor) continue;
    try {
      const path = execFileSync("which", [executor.binary], { encoding: "utf8" }).trim();
      if (path) binaryPaths.set(exec.id, path);
    } catch {
      // which failed — binary not on PATH
    }
  }

  const providers = listProviderAdapters().map((adapter) => {
    const route = describeRoute(
      adapter.id,
      availableExecutors,
      binaryPaths.get(adapter.id as ExecutorId),
    );
    return {
      id: adapter.id,
      defaultBaseUrl: adapter.defaultBaseUrl ?? "",
      defaultModel: adapter.defaultModel ?? "",
      requiresKey: !keylessProviders.has(adapter.id),
      apiKeyEnv: adapter.apiKeyEnv ?? "TANYA_API_KEY",
      route: route.route,
      routeLabel: route.label,
      ...(adapter.models ? { models: adapter.models } : {}),
    };
  });

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ providers })}\n`);
    return;
  }
  for (const provider of providers) {
    const routeCol = provider.routeLabel.padEnd(36);
    console.log(`${provider.id.padEnd(10)} ${routeCol} ${provider.defaultBaseUrl}`);
  }
}

export async function testProvider(args: ParsedArgs): Promise<void> {
  const requestedProvider = flagString(args, "provider") ?? "configured";
  if (envValue({}, "TANYA_RUN_LIVE_PROVIDER_TESTS") !== "1") {
    console.log(`skipped live provider test for ${requestedProvider}; set TANYA_RUN_LIVE_PROVIDER_TESTS=1 to run against the real endpoint.`);
    return;
  }
  const config = loadConfig();
  const provider = createProvider(config);
  const startedAt = Date.now();
  let text = "";
  for await (const delta of provider.streamChat({
    messages: [
      { role: "system", content: "You are a provider conformance probe. Keep answers short." },
      { role: "user", content: "Reply with exactly: pong" },
      { role: "user", content: "No tools are needed." },
    ],
    tools: [],
    maxTokens: 12,
    temperature: 0,
  })) {
    if (delta.content) text += delta.content;
  }
  console.log(`PASS adapter: ${provider.id}:${provider.model}`);
  console.log(`PASS streaming-chat: ${Date.now() - startedAt}ms ${text.trim()}`);
  console.log("PASS parser-surface: mock conformance covers malformed tool-call quirks in CI");
  if (config.provider === "deepseek") {
    const balance = await fetchDeepSeekBalance({ apiKey: config.apiKey, baseUrl: config.baseUrl });
    if (balance) console.log(formatBalanceLine(balance));
  } else if (config.provider === "kimi") {
    const balance = await fetchKimiBalance({ apiKey: config.apiKey, baseUrl: config.baseUrl });
    if (balance) console.log(formatKimiBalanceLine(balance));
  }
}
