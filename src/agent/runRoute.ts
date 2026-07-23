import type { ExecutorId } from "../executors/types";

// Providers whose vendor CLI is preferred over native API when available.
export const CLI_STRICT_PROVIDERS: ReadonlySet<string> = new Set([
  "claude",
  "cursor",
  "codex",
  "kimi",
]);

export interface RunRouteInput {
  /** Resolved provider id, e.g. "claude", "deepseek", "kimi". */
  provider: string;
  /** Any explicit --backend flag or TANYA_BACKEND env value ("" if unset). */
  requestedBackend: string;
  /** --via mode: "api" | "cli" | undefined. Also populated from metadata.via. */
  via?: string | undefined;
  /** Available executors from listExecutors(). */
  availableExecutors: Array<{ id: ExecutorId; available: boolean }>;
}

export type RunRoute = ApiRoute | CliRoute;

export interface ApiRoute {
  route: "api";
}

export interface CliRoute {
  route: "cli";
  backend: ExecutorId;
}

/**
 * Resolve whether a run should use the vendor's external CLI or the native
 * API loop.
 *
 * Policy (CLI-strict, 2026-07-19):
 *   claude, cursor, codex, kimi → prefer vendor CLI when installed.
 *   --via api → force native API.
 *   --via cli → force CLI (error if not installed).
 *   --backend <name> → explicit external executor.
 *   Otherwise → native API.
 */
export function resolveRunRoute(input: RunRouteInput): RunRoute {
  const { provider, requestedBackend, via, availableExecutors } = input;

  // 1. Explicit --via overrides everything.
  const viaMode = via?.trim().toLowerCase();
  if (viaMode === "api") {
    return { route: "api" };
  }
  if (viaMode === "cli") {
    const target = normalizeBackend(requestedBackend) ?? provider;
    const exec = availableExecutors.find((e) => e.id === target);
    if (!exec) {
      throw new Error(
        `--via cli requires a CLI backend but "${target}" has no registered executor. ` +
          `Available backends: ${availableExecutors.map((e) => e.id).join(", ")}.`,
      );
    }
    if (!exec.available) {
      throw new Error(
        `--via cli requires the "${target}" CLI to be installed and logged in. ` +
          `Run "${target} login" or install the CLI, then retry.`,
      );
    }
    return { route: "cli", backend: exec.id };
  }

  // 2. Explicit --backend / TANYA_BACKEND takes priority.
  // "self" means use the native API loop — skip CLI routing entirely.
  if (requestedBackend === "self") {
    return { route: "api" };
  }
  if (requestedBackend) {
    const exec = availableExecutors.find((e) => e.id === requestedBackend);
    if (!exec) {
      throw new Error(
        `Unknown backend "${requestedBackend}". Available: ${availableExecutors.map((e) => e.id).join(", ")}, self`,
      );
    }
    if (!exec.available) {
      throw new Error(
        `Backend "${requestedBackend}" is not available. Run "${requestedBackend} login" or install the CLI.`,
      );
    }
    return { route: "cli", backend: exec.id };
  }

  // 3. CLI-strict auto-inference: provider in the CLI-strict set AND its
  //    vendor CLI is available → route through executor.
  if (CLI_STRICT_PROVIDERS.has(provider)) {
    const exec = availableExecutors.find((e) => e.id === provider);
    if (exec?.available) {
      return { route: "cli", backend: exec.id };
    }
  }

  // 4. Fall through to native API loop.
  return { route: "api" };
}

/**
 * Normalize a backend id string to valid ExecutorId or undefined.
 */
function normalizeBackend(raw: string): ExecutorId | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "claude" || trimmed === "codex" || trimmed === "cursor") {
    return trimmed as ExecutorId;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Visibility helpers (Part 2 — ORCH-01)
// ---------------------------------------------------------------------------

export interface RouteDescription {
  route: "api" | "cli";
  /** Human-readable label, e.g. "API" or "CLI (/usr/local/bin/claude)". */
  label: string;
}

/**
 * Describe how a provider will route: through the vendor CLI or the native
 * API loop.
 *
 * When `binaryPath` is provided and the route is CLI, it is embedded in the
 * label (e.g. `"CLI (/usr/local/bin/claude)"`). Callers should resolve the
 * actual binary path from the executor's `binary` field via `which`.
 */
export function describeRoute(
  providerId: string,
  availableExecutors: Array<{ id: ExecutorId; available: boolean }>,
  binaryPath?: string,
): RouteDescription {
  if (CLI_STRICT_PROVIDERS.has(providerId)) {
    const exec = availableExecutors.find((e) => e.id === providerId);
    if (exec?.available) {
      const pathSuffix = binaryPath ? ` (${binaryPath})` : "";
      return { route: "cli", label: `CLI${pathSuffix}` };
    }
    return { route: "api", label: "API (CLI not installed)" };
  }
  return { route: "api", label: "API" };
}
