import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliEntry = fileURLToPath(new URL("../../cli.ts", import.meta.url));

function runCli(args: string[], env: NodeJS.ProcessEnv): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("npx", ["tsx", cliEntry, ...args], {
      encoding: "utf8",
      env: { ...env, TANYA_SUPPRESS_DEPRECATION: "1" },
    });
    return { stdout, status: 0 };
  } catch (error) {
    const err = error as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? "", status: err.status ?? 1 };
  }
}

describe("doctor --json", () => {
  it("emits structured checks and reports a missing key as a fail instead of throwing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-doctor-"));
    // Strip provider keys so loadConfig would otherwise throw.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.TANYA_API_KEY;
    delete env.DEEPSEEK_API_KEY;
    const { stdout, status } = runCli(["doctor", "--json", "--cwd", cwd], env);
    const parsed = JSON.parse(stdout.trim());
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.summary.fail).toBeGreaterThan(0);
    expect(parsed.checks.some((c: { name: string }) => c.name === "provider.config")).toBe(true);
    expect(status).toBe(1);
  }, 30_000);
});

describe("providers list --json", () => {
  it("lists registered adapters with key requirements", () => {
    const { stdout } = runCli(["providers", "list", "--json"], process.env);
    const parsed = JSON.parse(stdout.trim());
    const deepseek = parsed.providers.find((p: { id: string }) => p.id === "deepseek");
    expect(deepseek).toMatchObject({ requiresKey: true, apiKeyEnv: "DEEPSEEK_API_KEY" });
    const kimi = parsed.providers.find((p: { id: string }) => p.id === "kimi");
    expect(kimi).toMatchObject({
      requiresKey: true,
      apiKeyEnv: "KIMI_API_KEY",
      defaultModel: "kimi-k2.7-code",
      defaultBaseUrl: "https://api.moonshot.ai/v1",
    });
    const ollama = parsed.providers.find((p: { id: string }) => p.id === "ollama");
    expect(ollama.requiresKey).toBe(false);
    const claude = parsed.providers.find((p: { id: string }) => p.id === "claude");
    expect(claude).toBeDefined();
    expect(Array.isArray(claude.models)).toBe(true);
    expect(claude.models.length).toBeGreaterThan(0);
    expect(claude.models[0]).toBe(claude.defaultModel);
    const openai = parsed.providers.find((p: { id: string }) => p.id === "openai");
    expect(openai).toBeDefined();
    expect(Array.isArray(openai.models)).toBe(true);
    expect(openai.models.length).toBeGreaterThan(0);
    expect(openai.models[0]).toBe(openai.defaultModel);
  }, 30_000);

  // ORCH-01 Part 2 — route visibility
  it("includes route and routeLabel for every provider", () => {
    const { stdout } = runCli(["providers", "list", "--json"], process.env);
    const parsed = JSON.parse(stdout.trim());
    expect(Array.isArray(parsed.providers)).toBe(true);
    expect(parsed.providers.length).toBeGreaterThan(0);

    for (const p of parsed.providers) {
      expect(typeof p.route).toBe("string");
      expect(["api", "cli"]).toContain(p.route);
      expect(typeof p.routeLabel).toBe("string");
      expect(p.routeLabel.length).toBeGreaterThan(0);
      // route and routeLabel must be consistent
      if (p.route === "api") {
        expect(p.routeLabel).toMatch(/^API/);
      } else if (p.route === "cli") {
        expect(p.routeLabel).toMatch(/^CLI/);
      }
    }
  }, 30_000);

  it("non-CLI-strict providers report route=api", () => {
    const { stdout } = runCli(["providers", "list", "--json"], process.env);
    const parsed = JSON.parse(stdout.trim());

    const deepseek = parsed.providers.find((p: { id: string }) => p.id === "deepseek");
    expect(deepseek).toBeDefined();
    expect(deepseek.route).toBe("api");
    expect(deepseek.routeLabel).toBe("API");

    const openai = parsed.providers.find((p: { id: string }) => p.id === "openai");
    expect(openai).toBeDefined();
    expect(openai.route).toBe("api");
    expect(openai.routeLabel).toBe("API");
  }, 30_000);
});
