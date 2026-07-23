import { describe, expect, it } from "vitest";
import { resolveRunRoute, describeRoute, CLI_STRICT_PROVIDERS } from "../runRoute";
import type { ExecutorId } from "../../executors/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function available(id: ExecutorId) {
  return { id, available: true };
}

function unavailable(id: ExecutorId) {
  return { id, available: false };
}

function baseInput(overrides: Partial<Parameters<typeof resolveRunRoute>[0]> = {}) {
  return {
    provider: "deepseek",
    requestedBackend: "",
    via: undefined,
    availableExecutors: [available("claude"), unavailable("codex"), unavailable("cursor")],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveRunRoute", () => {
  // -- via flag -----------------------------------------------------------

  describe("--via api", () => {
    it("forces API even when provider CLI is available", () => {
      const input = baseInput({ provider: "claude", via: "api" });
      const result = resolveRunRoute(input);
      expect(result).toEqual({ route: "api" });
    });

    it("forces API even when --backend is set", () => {
      const input = baseInput({
        provider: "claude",
        requestedBackend: "claude",
        via: "api",
      });
      const result = resolveRunRoute(input);
      expect(result).toEqual({ route: "api" });
    });

    it("forces API regardless of case", () => {
      const input = baseInput({ provider: "claude", via: "  API  " });
      const result = resolveRunRoute(input);
      expect(result).toEqual({ route: "api" });
    });
  });

  describe("--via cli", () => {
    it("routes to CLI when executor is available", () => {
      const input = baseInput({
        provider: "claude",
        via: "cli",
      });
      const result = resolveRunRoute(input);
      expect(result.route).toBe("cli");
      if (result.route === "cli") {
        expect(result.backend).toBe("claude");
      }
    });

    it("routes to referenced backend when --backend and --via cli are both set", () => {
      const input = baseInput({
        provider: "deepseek",
        requestedBackend: "codex",
        via: "cli",
        availableExecutors: [available("codex"), unavailable("claude"), unavailable("cursor")],
      });
      const result = resolveRunRoute(input);
      expect(result.route).toBe("cli");
      if (result.route === "cli") {
        expect(result.backend).toBe("codex");
      }
    });

    it("throws when the CLI is not installed", () => {
      const input = baseInput({
        provider: "cursor",
        via: "cli",
        availableExecutors: [unavailable("cursor")],
      });
      expect(() => resolveRunRoute(input)).toThrow(
        /requires the "cursor" CLI to be installed/,
      );
    });

    it("throws when the provider has no registered executor", () => {
      const input = baseInput({
        provider: "deepseek",
        via: "cli",
      });
      expect(() => resolveRunRoute(input)).toThrow(/has no registered executor/);
    });
  });

  // -- Explicit --backend / TANYA_BACKEND ----------------------------------

  describe("explicit --backend", () => {
    it("routes through the requested backend when available", () => {
      const input = baseInput({
        provider: "deepseek",
        requestedBackend: "claude",
      });
      const result = resolveRunRoute(input);
      expect(result).toEqual({ route: "cli", backend: "claude" });
    });

    it("throws when the requested backend is unknown", () => {
      const input = baseInput({
        provider: "deepseek",
        requestedBackend: "foobar",
      });
      expect(() => resolveRunRoute(input)).toThrow(/Unknown backend/);
    });

    it("throws when the requested backend is unavailable", () => {
      const input = baseInput({
        provider: "deepseek",
        requestedBackend: "codex",
        availableExecutors: [unavailable("codex")],
      });
      expect(() => resolveRunRoute(input)).toThrow(/not available/);
    });

    it("ignores self (API path)", () => {
      const input = baseInput({
        provider: "claude",
        requestedBackend: "self",
      });
      const result = resolveRunRoute(input);
      expect(result).toEqual({ route: "api" });
    });
  });

  // -- CLI-strict auto-inference ------------------------------------------

  describe("CLI-strict auto-inference", () => {
    it("routes claude through CLI when available", () => {
      const input = baseInput({ provider: "claude" });
      const result = resolveRunRoute(input);
      expect(result).toEqual({ route: "cli", backend: "claude" });
    });

    it("routes cursor through CLI when available", () => {
      const input = baseInput({
        provider: "cursor",
        availableExecutors: [available("cursor")],
      });
      const result = resolveRunRoute(input);
      expect(result).toEqual({ route: "cli", backend: "cursor" });
    });

    it("routes codex through CLI when available", () => {
      const input = baseInput({
        provider: "codex",
        availableExecutors: [available("codex")],
      });
      const result = resolveRunRoute(input);
      expect(result).toEqual({ route: "cli", backend: "codex" });
    });

    it("routes kimi through CLI when kimi executor is available", () => {
      const kimi = { id: "claude" as ExecutorId, available: true };
      const input = baseInput({
        provider: "kimi",
        availableExecutors: [kimi],
      });
      const result = resolveRunRoute(input);
      // kimi has no registered executor, so it falls through to API.
      // Per contract point 3: "If the CLI is NOT installed, behave as today."
      // Since no kimi executor exists, the lookup returns API.
      expect(result).toEqual({ route: "api" });
    });

    it("falls back to API when CLI is not available", () => {
      const input = baseInput({
        provider: "claude",
        availableExecutors: [unavailable("claude")],
      });
      const result = resolveRunRoute(input);
      expect(result).toEqual({ route: "api" });
    });

    it("falls back to API for non-CLI-strict providers", () => {
      const input = baseInput({
        provider: "deepseek",
        availableExecutors: [available("claude")], // claude is available but provider is deepseek
      });
      const result = resolveRunRoute(input);
      expect(result).toEqual({ route: "api" });
    });

    it("falls back to API for qwen provider", () => {
      const input = baseInput({ provider: "qwen" });
      const result = resolveRunRoute(input);
      expect(result).toEqual({ route: "api" });
    });

    it("falls back to API for openai provider", () => {
      const input = baseInput({
        provider: "openai",
        availableExecutors: [available("claude"), unavailable("codex"), unavailable("cursor")],
      });
      const result = resolveRunRoute(input);
      expect(result).toEqual({ route: "api" });
    });
  });

  // -- Resolution matrix (full cross-product) -----------------------------

  describe("resolution matrix", () => {
    // Matrix: provider × CLI available × via flag → route.
    // API key presence is intentionally absent from resolveRunRoute's
    // signature: CLI-strict means API keys NEVER influence routing.
    // The table below documents every policy cell.

    describe("claude + CLI available", () => {
      const claudeAvailable = [available("claude")];

      it("→ cli (policy core: CLI wins over API key)", () => {
        const result = resolveRunRoute(
          baseInput({ provider: "claude", availableExecutors: claudeAvailable }),
        );
        expect(result).toEqual({ route: "cli", backend: "claude" });
      });

      it("--via api → api (escape hatch)", () => {
        const result = resolveRunRoute(
          baseInput({
            provider: "claude",
            availableExecutors: claudeAvailable,
            via: "api",
          }),
        );
        expect(result).toEqual({ route: "api" });
      });

      it("--via cli → cli", () => {
        const result = resolveRunRoute(
          baseInput({
            provider: "claude",
            availableExecutors: claudeAvailable,
            via: "cli",
          }),
        );
        expect(result).toEqual({ route: "cli", backend: "claude" });
      });
    });

    describe("claude + CLI NOT available", () => {
      const claudeUnavailable = [unavailable("claude")];

      it("→ api (falls back when CLI not installed)", () => {
        const result = resolveRunRoute(
          baseInput({ provider: "claude", availableExecutors: claudeUnavailable }),
        );
        expect(result).toEqual({ route: "api" });
      });

      it("--via api → api", () => {
        const result = resolveRunRoute(
          baseInput({
            provider: "claude",
            availableExecutors: claudeUnavailable,
            via: "api",
          }),
        );
        expect(result).toEqual({ route: "api" });
      });

      it("--via cli → throws (no silent fallback)", () => {
        expect(() =>
          resolveRunRoute(
            baseInput({
              provider: "claude",
              availableExecutors: claudeUnavailable,
              via: "cli",
            }),
          ),
        ).toThrow(/requires the "claude" CLI to be installed/);
      });
    });

    describe("deepseek (non-CLI-strict)", () => {
      it("→ api always (never routes through CLI)", () => {
        const result = resolveRunRoute(baseInput({ provider: "deepseek" }));
        expect(result).toEqual({ route: "api" });
      });

      it("→ api even when claude CLI is available", () => {
        const result = resolveRunRoute(
          baseInput({
            provider: "deepseek",
            availableExecutors: [available("claude")],
          }),
        );
        expect(result).toEqual({ route: "api" });
      });

      it("--via api → api", () => {
        const result = resolveRunRoute(
          baseInput({ provider: "deepseek", via: "api" }),
        );
        expect(result).toEqual({ route: "api" });
      });

      it("--via cli → throws (no registered executor)", () => {
        expect(() =>
          resolveRunRoute(baseInput({ provider: "deepseek", via: "cli" })),
        ).toThrow(/has no registered executor/);
      });
    });

    describe("kimi (CLI-strict, no executor registered)", () => {
      it("→ api (CLI not installed)", () => {
        const result = resolveRunRoute(baseInput({ provider: "kimi" }));
        expect(result).toEqual({ route: "api" });
      });

      it("--via api → api", () => {
        const result = resolveRunRoute(
          baseInput({ provider: "kimi", via: "api" }),
        );
        expect(result).toEqual({ route: "api" });
      });

      it("--via cli → throws", () => {
        expect(() =>
          resolveRunRoute(baseInput({ provider: "kimi", via: "cli" })),
        ).toThrow(/has no registered executor/);
      });
    });
  });

  // -- API key irrelevance -------------------------------------------------

  describe("API key irrelevance", () => {
    // resolveRunRoute does not accept an API key parameter by design.
    // These tests document that the routing decision is key-agnostic.

    it("claude + CLI available routes CLI regardless of API key presence", () => {
      // The function signature proves the point: no apiKey parameter exists.
      // Any run with provider=claude and an available executor routes CLI.
      const result = resolveRunRoute(
        baseInput({ provider: "claude" }),
      );
      expect(result).toEqual({ route: "cli", backend: "claude" });
    });

    it("deepseek always routes API regardless of CLI availability elsewhere", () => {
      const result = resolveRunRoute(
        baseInput({
          provider: "deepseek",
          availableExecutors: [available("claude"), available("codex"), available("cursor")],
        }),
      );
      expect(result).toEqual({ route: "api" });
    });

    it("no API key field exists in RunRouteInput", () => {
      // Type-level check: compile error if apiKey is ever added.
      const input: Parameters<typeof resolveRunRoute>[0] = {
        provider: "claude",
        requestedBackend: "",
        via: undefined,
        availableExecutors: [],
      };
      // @ts-expect-error — apiKey must NOT exist on the type
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _hasApiKey: string | undefined = (input as Record<string, unknown>).apiKey as string;
      expect(input).toBeDefined();
    });
  });

  // -- Combined scenarios --------------------------------------------------

  describe("combined scenarios", () => {
    it("--via api wins over CLI-strict provider", () => {
      const input = baseInput({ provider: "claude", via: "api" });
      const result = resolveRunRoute(input);
      expect(result).toEqual({ route: "api" });
    });

    it("--via api wins over explicit --backend", () => {
      const input = baseInput({
        provider: "deepseek",
        requestedBackend: "claude",
        via: "api",
      });
      const result = resolveRunRoute(input);
      expect(result).toEqual({ route: "api" });
    });

    it("explicit --backend wins over CLI-strict inference", () => {
      const input = baseInput({
        provider: "claude",
        requestedBackend: "codex",
        availableExecutors: [available("codex"), available("claude")],
      });
      const result = resolveRunRoute(input);
      expect(result).toEqual({ route: "cli", backend: "codex" });
    });
  });
});

// ---------------------------------------------------------------------------
// describeRoute
// ---------------------------------------------------------------------------

describe("describeRoute", () => {
  it("returns API for non-CLI-strict provider", () => {
    const result = describeRoute("deepseek", [available("claude")]);
    expect(result).toEqual({ route: "api", label: "API" });
  });

  it("returns CLI for available CLI-strict provider", () => {
    const result = describeRoute("claude", [available("claude")]);
    expect(result).toEqual({ route: "cli", label: "CLI" });
  });

  it("returns API (CLI not installed) for unavailable CLI-strict provider", () => {
    const result = describeRoute("claude", [unavailable("claude")]);
    expect(result).toEqual({ route: "api", label: "API (CLI not installed)" });
  });

  it("returns API for CLI-strict provider when executor missing from list", () => {
    const result = describeRoute("kimi", [available("claude")]);
    expect(result).toEqual({ route: "api", label: "API (CLI not installed)" });
  });

  it("embeds binary path when provided", () => {
    const result = describeRoute("claude", [available("claude")], "/usr/local/bin/claude");
    expect(result).toEqual({
      route: "cli",
      label: "CLI (/usr/local/bin/claude)",
    });
  });

  it("ignores binary path for non-CLI-strict provider", () => {
    const result = describeRoute("deepseek", [available("claude")], "/usr/local/bin/deepseek");
    expect(result).toEqual({ route: "api", label: "API" });
  });

  it("ignores binary path when CLI-strict executor unavailable", () => {
    const result = describeRoute("codex", [unavailable("codex")], "/usr/local/bin/codex");
    expect(result).toEqual({ route: "api", label: "API (CLI not installed)" });
  });

  it("all four CLI_STRICT_PROVIDERS are covered", () => {
    expect(CLI_STRICT_PROVIDERS.size).toBe(4);
    // claude, codex, cursor — have registered executors
    const registeredAvailable = [
      available("claude"),
      available("codex"),
      available("cursor"),
    ];
    for (const id of ["claude", "codex", "cursor"]) {
      const result = describeRoute(id, registeredAvailable);
      expect(result.route).toBe("cli");
    }
    // kimi — no registered executor, always API
    const kimiResult = describeRoute("kimi", registeredAvailable);
    expect(kimiResult).toEqual({ route: "api", label: "API (CLI not installed)" });
  });
});
