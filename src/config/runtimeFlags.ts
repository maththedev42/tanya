// The one typed surface for behavioral TANYA_* runtime flags.
//
// Two things live here:
//  1. Typed accessor primitives that reproduce the repo's established parse
//     idioms exactly (on-switch, off-switch, clamped ints, ratios, optional
//     ceilings, off-able ceilings). Call sites migrate onto these instead of
//     hand-rolling per-file parsers.
//  2. RUNTIME_FLAGS — the complete documented registry of every behavioral
//     flag (name, kind, default, description). `.env.example` is GENERATED
//     from this table (scripts/gen-env-example.ts); a test fails when the
//     file on disk drifts from the table.
//
// Provider/connection configuration (TANYA_PROVIDER, TANYA_API_KEY,
// TANYA_BASE_URL, TANYA_MODEL, TANYA_PROFILE, TANYA_TEMPERATURE, TANYA_TOP_P,
// TANYA_TIMEOUT_MS, provider-specific keys) stays in config/env.ts loadConfig —
// those have provider-conditional fallback chains this registry only documents.

import { envValue } from "./envCompat";

const ON_PATTERN = /^(1|true|yes|on)$/i;
const OFF_PATTERN = /^(0|false|off|no)$/i;

/** Default-OFF boolean: enabled only by an explicit 1|true|yes|on. */
export function onFlag(key: string): boolean {
  return ON_PATTERN.test(envValue(process.env, key).trim());
}

/** Default-ON boolean: stays enabled unless explicitly 0|false|off|no. */
export function offFlag(key: string): boolean {
  const raw = process.env[key];
  return !(raw !== undefined && OFF_PATTERN.test(raw.trim()));
}

/** Positive integer with a fallback: unset/empty/invalid/non-positive → fallback. */
export function positiveIntFlag(key: string, fallback: number): number {
  const raw = envValue(process.env, key).trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Optional positive integer: unset/empty/invalid → undefined (= feature default). */
export function optionalPositiveIntFlag(key: string): number | undefined {
  const raw = process.env[key];
  if (!raw || !raw.trim()) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

/** Positive integer ceiling that 0|off|false|no disables (returns 0). */
export function offablePositiveIntFlag(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (OFF_PATTERN.test(raw.trim())) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Ratio in (0, 1]: anything else → fallback. */
export function ratioFlag(key: string, fallback: number): number {
  const parsed = Number(envValue(process.env, key));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

/** Integer with a floor clamp: invalid → fallback, then max(min, floor(n)). */
export function clampedIntFlag(key: string, fallback: number, min: number): number {
  const raw = envValue(process.env, key);
  const parsed = raw ? Number(raw) : NaN;
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.floor(value));
}

/** Trimmed string, "" when unset. */
export function stringFlag(key: string): string {
  return envValue(process.env, key).trim();
}

export type FlagKind =
  | "on" // boolean, default OFF; enable with 1|true|yes|on
  | "off" // boolean, default ON; disable with 0|false|off|no
  | "int" // integer knob
  | "ratio" // number in (0, 1]
  | "string" // free-form string / path
  | "enum"; // one of a fixed set (values in the description)

export interface RuntimeFlagDoc {
  name: string;
  kind: FlagKind;
  /** Display default for docs/.env.example ("" for none). */
  default: string;
  description: string;
  section: string;
  /** Internal plumbing (set by Tanya itself, not user configuration) — documented but excluded from .env.example. */
  internal?: boolean;
}

const F = (
  name: string,
  kind: FlagKind,
  dflt: string,
  description: string,
  section: string,
  internal?: boolean,
): RuntimeFlagDoc => ({ name, kind, default: dflt, description, section, ...(internal ? { internal: true } : {}) });

/** Every behavioral TANYA_* flag, grouped by subsystem. Provider/connection
 *  vars (see header) are documented in the generated provider section of
 *  .env.example instead. */
export const RUNTIME_FLAGS: RuntimeFlagDoc[] = [
  // ── agent: run behavior ──
  F("TANYA_MODE", "enum", "", "Permission mode override: safe | auto | bypass. Unset = per-command default.", "agent"),
  F("TANYA_MAX_TURNS", "int", "", "Interactive soft turn budget override; unset = adaptive. Shifts where stall detection begins.", "agent"),
  F("TANYA_HARD_TURN_CEILING", "int", "", "Absolute turn ceiling for extended runs. Unset = unbounded (progress-based stops only).", "agent"),
  F("TANYA_MAX_STALL_TOKENS", "int", "1500000", "Prompt-token backstop for stalled runs (no progress 2+ turns). 0|off disables.", "agent"),
  F("TANYA_AUTO_CONTINUE", "int", "2", "Serve: automatic continue budget after a stall stop. 0|off disables.", "agent"),
  F("TANYA_PROMPT_BUDGET_RATIO", "ratio", "0.25", "Fraction of the context window reserved for the prompt-side budget.", "agent"),
  F("TANYA_LITE_PROMPT", "on", "", "Slim system prompt (drops heavyweight sections) for small-context providers.", "agent"),
  F("TANYA_ESCALATION_CAP", "int", "5", "Max model-escalation hops per run (min 0).", "agent"),
  F("TANYA_REASONING_CAP_SHORT", "int", "2000", "Per-turn reasoning-token budget for planning/tool-call steps (min 1).", "agent"),
  F("TANYA_REASONING_CAP_LONG", "int", "8000", "Per-turn reasoning-token budget for synthesis/verification steps (min 1).", "agent"),
  F("TANYA_FIRST_BUILD_NUDGE_AFTER", "int", "3", "Mutations before the first build-verification nudge.", "agent"),
  F("TANYA_SENTINEL_FLUSH_EVERY", "int", "8", "Flush a RUN_IN_PROGRESS heartbeat every N mutations (kill -9 evidence).", "agent"),
  // ── agent: gates ──
  F("TANYA_TASK_GATES", "off", "on", "Interactive task-completion gates (spec coverage, verify, commit).", "gates"),
  F("TANYA_DOD_GATE", "off", "on", "Runtime definition-of-done gate for behavioral criteria in coding prompts.", "gates"),
  F("TANYA_RECOVERY", "off", "on", "Recovery preflight (doctor + RECOVERY block) after a FAILed run.", "gates"),
  F("TANYA_DRIFT_GUARD", "off", "on", "Read-only drift guard: nudges then wraps up coding runs that never edit.", "gates"),
  F("TANYA_SNAPSHOTS", "off", "on", "Turn snapshots: side-repo snapshot of the touched repo before a turn's first mutating tool (tanya restore).", "gates"),
  F("TANYA_STUCK_GUARD", "off", "on", "Unified stuck guard: fingerprint repeated identical failures (incl. re-spelled commands), warn then wrap up.", "gates"),
  F("TANYA_SNAPSHOTS_DIR", "string", "", "Override the side-repo snapshot store (default ~/.tanya/snapshots).", "gates"),
  F("TANYA_VERIFIER_INCLUDE_REASONING", "on", "", "Include model reasoning in verifier transcripts.", "gates"),
  F("TANYA_VERIFIER_SHELL", "string", "", "Shell used by verify commands (path or name).", "gates"),
  F("TANYA_RUNTIME_CHECK", "on", "", "Runtime boot verification for generated apps.", "gates"),
  F("TANYA_TIER1", "on", "", "Tier-1 runtime verification profile.", "gates"),
  // ── subagents / subtasks ──
  F("TANYA_SUBAGENT_CONCURRENCY", "int", "3", "Max concurrent subagent jobs.", "subagents"),
  F("TANYA_SUBAGENT_DEPTH", "int", "", "Current subagent nesting depth. Set by Tanya for child processes.", "subagents", true),
  F("TANYA_SUBTASK_MAX_PARALLEL", "int", "3", "Max parallel subtasks (min 1).", "subagents"),
  F("TANYA_SUBTASK_MAX_DEPTH", "int", "2", "Max subtask nesting depth.", "subagents"),
  F("TANYA_SUBTASK_CYCLE_CHECK", "off", "on", "Detect and refuse cyclic subtask graphs.", "subagents"),
  // ── context / repo map ──
  F("TANYA_REPO_MAP_PROMPT_BUDGET", "int", "1000", "Token budget for the repo map in the system prompt.", "context"),
  F("TANYA_REPO_MAP_MAX_FILE_BYTES", "int", "", "Skip files larger than this when building the repo map.", "context"),
  // ── providers / routing ──
  F("TANYA_ROUTE_SAFETY_FACTOR", "ratio", "0.85", "Context-window safety factor for route resolution.", "routing"),
  F("TANYA_PROVIDER_CONCURRENCY", "int", "", "Max concurrent provider requests.", "routing"),
  F("TANYA_SUPPRESS_DEPRECATION", "on", "", "Silence provider deprecation warnings (=1).", "routing"),
  F("TANYA_DEBUG", "on", "", "Verbose provider debug logging.", "routing"),
  F("TANYA_BACKEND", "string", "", "Default external backend for run routing (claude | codex | ...).", "routing"),
  // ── UI / serve ──
  F("TANYA_TUI", "on", "", "Force the TUI renderer.", "ui"),
  F("TANYA_HIDE_REASONING", "on", "", "Hide streamed reasoning in the human sink.", "ui"),
  F("TANYA_LIVE_STATUS", "off", "on", "Live status line during runs.", "ui"),
  F("TANYA_UI_MODEL", "string", "", "Model for UI/companion calls (falls back to the main model).", "ui"),
  F("TANYA_UI_BASE_URL", "string", "", "Base URL for UI/companion calls.", "ui"),
  F("TANYA_UI_API_KEY", "string", "", "API key for UI/companion calls.", "ui"),
  // ── tools ──
  F("TANYA_PROGRESS_THROTTLE_MS", "int", "", "Throttle for streamed tool progress events.", "tools"),
  F("TANYA_MCP_CALL_TIMEOUT_MS", "int", "30000", "Timeout per MCP tool call (min 1000).", "tools"),
  F("TANYA_CHROME_PATH", "string", "", "Chrome/Chromium binary for video tools.", "tools"),
  F("TANYA_FFMPEG_PATH", "string", "", "ffmpeg binary for video/ad tools.", "tools"),
  // ── memory / pricing ──
  F("TANYA_MEMORY_HOME", "string", "", "Override for the cross-session repair-memory home directory.", "memory"),
  F("TANYA_OBSIDIAN_VAULT", "string", "", "Obsidian vault path — completed tasks are appended to daily notes.", "memory"),
  F("TANYA_PRICE_INPUT_PER_MTOK", "string", "", "Override input price per Mtok for cost estimates.", "memory"),
  F("TANYA_PRICE_OUTPUT_PER_MTOK", "string", "", "Override output price per Mtok for cost estimates.", "memory"),
  F("TANYA_PRICE_CACHE_HIT_PER_MTOK", "string", "", "Override cache-hit price per Mtok for cost estimates.", "memory"),
  // ── maintenance ──
  F("TANYA_AUTO_CLEAN", "off", "on", "Automatic workspace hygiene (stale artifacts, temp dirs).", "maintenance"),
  F("TANYA_DISK_GUARD", "off", "on", "Refuse heavy work when free disk is below the minimum.", "maintenance"),
  F("TANYA_DISK_MIN_GB", "int", "", "Minimum free disk (GB) for the disk guard.", "maintenance"),
  F("TANYA_REAP_DAEMONS", "off", "on", "Reap orphaned helper daemons during hygiene runs.", "maintenance"),
  // ── sessions / eval / integrations ──
  F("TANYA_RUN_SESSIONS", "on", "", "Record run sessions for the session browser.", "sessions"),
  F("TANYA_EVAL_PARALLEL", "int", "", "Parallelism for eval suite runs.", "eval"),
  F("TANYA_EVAL_TASK_TIMEOUT_MS", "int", "", "Per-task timeout for eval runs.", "eval"),
  F("TANYA_EVAL_TASK_TOKEN_CAP", "int", "", "Per-task token cap for eval runs.", "eval"),
  F("TANYA_RUN_LIVE_PROVIDER_TESTS", "on", "", "Enable live-provider tests (development only).", "eval", true),
  F("TANYA_INTEGRATIONS_DIR", "string", "", "Override the integrations discovery directory.", "integrations"),
  F("TANYA_COSMOCHAT_BASE_URL", "string", "", "CosmoChat integration base URL.", "integrations"),
  F("TANYA_COSMOCHAT_MESSAGE_END_GRACE_MS", "int", "", "Grace period before finalizing a CosmoChat message.", "integrations"),
  F("TANYA_COSMOCHAT_RUN_FINALIZE_URL", "string", "", "Per-run finalize callback URL. Set by the dispatcher.", "integrations", true),
  F("TANYA_COSMOCHAT_RUN_ID", "string", "", "Per-run CosmoChat id. Set by the dispatcher.", "integrations", true),
  F("TANYA_COSMOCHAT_SERVICE_TOKEN", "string", "", "CosmoChat service token. Set by the dispatcher.", "integrations", true),
];

const SECTION_TITLES: Record<string, string> = {
  agent: "Agent run behavior",
  gates: "Quality gates",
  subagents: "Subagents & subtasks",
  context: "Context / repo map",
  routing: "Providers & routing",
  ui: "UI & serve",
  tools: "Tools",
  memory: "Memory & pricing",
  maintenance: "Maintenance",
  sessions: "Sessions",
  eval: "Eval",
  integrations: "Integrations",
};

const PROVIDER_PREAMBLE = `# DeepSeek is the default provider.
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
TANYA_MODEL=deepseek-v4-pro

# Profile: "chat" (default) uses deepseek-v4-pro with 90s timeout.
# "reasoner" switches to deepseek-reasoner with 180s timeout.
# TANYA_PROFILE=reasoner

# Override timeout in ms (overrides profile default).
# TANYA_TIMEOUT_MS=180000

# Generic OpenAI-compatible provider support.
# TANYA_PROVIDER=custom
# TANYA_API_KEY=
# TANYA_BASE_URL=https://provider.example.com
# TANYA_MODEL=provider-model-name
`;

function flagLine(flag: RuntimeFlagDoc): string {
  const value = flag.kind === "on" ? "1" : flag.kind === "off" ? "off" : flag.default || "";
  return [`# ${flag.description}`, `# ${flag.name}=${value}`].join("\n");
}

/** Render the full .env.example content from the registry. Regenerate with
 *  `npx tsx scripts/gen-env-example.ts`; a test pins the file to this output. */
export function renderEnvExample(): string {
  const sections: string[] = [PROVIDER_PREAMBLE];
  const grouped = new Map<string, RuntimeFlagDoc[]>();
  for (const flag of RUNTIME_FLAGS) {
    if (flag.internal) continue;
    const list = grouped.get(flag.section) ?? [];
    list.push(flag);
    grouped.set(flag.section, list);
  }
  for (const [section, flags] of grouped) {
    const title = SECTION_TITLES[section] ?? section;
    sections.push([`# ── ${title} ${"─".repeat(Math.max(3, 58 - title.length))}`, ...flags.map(flagLine)].join("\n\n"));
  }
  return `${sections.join("\n\n")}\n`;
}
