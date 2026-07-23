import { existsSync, readdirSync, realpathSync } from "node:fs";
import { cp, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import type { TanyaTool, ToolContext, ToolResult } from "./types";
import { resolveInsideWorkspace } from "../safety/workspace";
import {
  createAndroidLauncherIconSetTool,
  createAppleAppIconSetTool,
  renderSvgToPngTool,
  resizeImageTool,
  validateAndroidLauncherIconSetTool,
  validateAppleAppIconSetTool,
} from "./imageTools";
import { readImageTool } from "./imageReadTools";
import { fetchUrlTool, webSearchTool } from "./webTools";
import { generateVideoAssetTool } from "./videoTools";
import { buildTaskBriefTool, findReusableArtifactsTool, inspectProjectContextTool } from "./projectContextTools";
import { searchObsidianNotesTool } from "./obsidianTools";
import { expandResultTool } from "./expandResult";
import { taskTool } from "./task";
import { subagentTools } from "./subagentTools";
import { updatePlanTool } from "./planTool";
import { editBlockTool } from "./editBlock";
import { inspectRepoMapTool } from "./repoMapTools";
import { recordMetricsDashboardHandoffTool } from "./metricsDashboardTools";
import {
  validateAndroidProjectConfigTool,
  validateApiContractRoutesTool,
  validateAppleProjectFilesTool,
  validateFastlaneConfigTool,
  validatePrismaSchemaTool,
} from "./fsValidators";
import {
  applyArtifactTool,
  commitPlatformChangesTool,
  createAndroidFoundationTool,
  createAndroidSplashTool,
  createIosSplashTool,
  generateAppIconsTool,
} from "./platformScaffold";

// Re-exported for existing importers (tests); the implementations moved to
// fsValidators.ts and platformScaffold.ts.
export {
  validateAndroidProjectConfigTool,
  validateApiContractRoutesTool,
  validateAppleProjectFilesTool,
  validateFastlaneConfigTool,
  validatePrismaSchemaTool,
} from "./fsValidators";
export {
  applyArtifactTool,
  commitPlatformChangesTool,
  createAndroidFoundationTool,
  createAndroidSplashTool,
  createIosSplashTool,
  generateAppIconsTool,
} from "./platformScaffold";

const ignoredNames = new Set([".git", "node_modules", ".next", "dist", "build", ".turbo", ".cache"]);
// Throttle for run_shell stdout/stderr → onProgress emits. Default 2s keeps
// the ink renderer responsive without spamming. Override via
// TANYA_PROGRESS_THROTTLE_MS so tests can use a smaller value and not flake
// under CI/publish-pipeline load. Read lazily because ES-module hoisting
// would otherwise capture the value before any test setup runs.
export function getProgressThrottleMs(): number {
  const raw = Number(process.env.TANYA_PROGRESS_THROTTLE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2_000;
}
// Back-compat re-export — most call sites import the constant. Keep it but
// flag the deprecation via the comment so future readers reach for the fn.
export const PROGRESS_THROTTLE_MS = getProgressThrottleMs();
export const MAX_WRITE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_PROCESS_BUFFER_BYTES = 16 * 1024 * 1024;

type CappedBuffer = {
  append: (chunk: string) => void;
  value: () => string;
  truncated: () => boolean;
};

// runShell historically hard-coded /bin/zsh, which ENOENTs on minimal Linux
// CI/dev containers. Resolve once at module load: prefer the user's $SHELL,
// then fall back to /bin/zsh and /bin/bash. The flags we pass (`-lc`) are
// portable across both shells.
function pickShellPath(): string {
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash"];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "/bin/zsh";
}
const SHELL_PATH = pickShellPath();

// Standard executable directories appended to PATH for bare (shell:false)
// command spawns. The PATH Tania inherits can be incomplete — a CLI host may
// launch it with a minimal env (no /usr/bin, /opt/homebrew/bin). The run_shell
// tool masks this by going through `zsh -lc`, which reloads the login PATH, but
// direct spawns resolve the binary against process.env.PATH and ENOENT
// ("Command failed to start") on bare `which`, `xcodebuild`, `swiftlint`, etc.
// — even though the very same tools resolve fine inside a shell. Appending the
// standard dirs (after the inherited PATH, so a deliberate toolchain still wins)
// makes bare commands as robust as shell commands.
const STANDARD_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

export function processEnvWithStandardPath(): NodeJS.ProcessEnv {
  const current = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of STANDARD_BIN_DIRS) {
    if (!current.includes(dir)) current.push(dir);
  }
  return { ...process.env, PATH: current.join(":") };
}

// Hard ceiling on accumulated process output. A runaway shell command (watching
// build, a flaky test loop, `cat` of a huge log) would otherwise inflate the
// buffer until the worker OOMs even when timeouts eventually kill the process.
function makeCappedBuffer(cap: number = MAX_PROCESS_BUFFER_BYTES): CappedBuffer {
  let text = "";
  let truncated = false;
  return {
    append(chunk: string): void {
      if (!chunk || truncated) return;
      const remaining = cap - text.length;
      if (chunk.length <= remaining) {
        text += chunk;
        return;
      }
      text += chunk.slice(0, Math.max(0, remaining));
      truncated = true;
    },
    value(): string {
      return truncated ? `${text}\n[output truncated at ${cap} bytes]` : text;
    },
    truncated(): boolean {
      return truncated;
    },
  };
}

export function isProtectedLocalConfigPath(filePath: string): boolean {
  return basename(filePath.trim().replace(/\\/g, "/")) === "local.properties";
}

export function localPropertiesWriteError(): ToolResult {
  return {
    ok: false,
    summary: "Rejected write to local.properties.",
    error: "local.properties is machine-local Android SDK configuration. Do not create or modify it; use ANDROID_HOME or ANDROID_SDK_ROOT for verification instead.",
  };
}

function shellSafetyBlock(summary: string, error: string): ToolResult {
  return {
    ok: false,
    summary,
    error,
    output: { ok: false, error, reason: "shell_safety_block" },
  };
}

export function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

export function asString(input: unknown, key: string): string {
  const value = asRecord(input)[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing string field: ${key}`);
  return value;
}

export function asOptionalNumber(input: unknown, key: string, fallback: number): number {
  const value = asRecord(input)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asOptionalString(input: unknown, key: string): string | undefined {
  const value = asRecord(input)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function asOptionalBoolean(input: unknown, key: string, fallback: boolean): boolean {
  const value = asRecord(input)[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(true|yes|1)$/i.test(value.trim());
  return fallback;
}

export async function pathExists(path: string): Promise<boolean> {
  return existsSync(path);
}

function collectFiles(root: string, maxFiles: number, current = root, out: string[] = []): string[] {
  if (out.length >= maxFiles) return out;
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (ignoredNames.has(entry.name)) continue;
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, maxFiles, fullPath, out);
    } else if (entry.isFile()) {
      out.push(relative(root, fullPath));
    }
    if (out.length >= maxFiles) break;
  }
  return out;
}

export function runProcess(
  command: string,
  args: string[],
  context: ToolContext,
  timeoutMs: number,
  cwd = context.workspace,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: processEnvWithStandardPath(),
      // stdin is /dev/null, NOT an open pipe: stdin-sniffing binaries (rg with
      // no path argument) otherwise block reading a pipe that never closes and
      // burn the whole timeout — the search tool never actually searched.
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = makeCappedBuffer();
    const stderr = makeCappedBuffer();
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk.toString());
    });
    child.on("close", (code) => {
      cleanup();
      const stderrText = stderr.value();
      const commandBinary = command.split("/").pop() ?? "";
      if (code === 1 && !stderrText.trim() && SEARCH_NO_MATCH_BINARIES.has(commandBinary)) {
        resolve(searchNoMatchResult(literalPipeHint(commandBinary, args.join(" "))));
        return;
      }
      const output = `${stdout.value()}${stderrText ? `\n${stderrText}` : ""}`.trim();
      if ((code === 1 || code === 2) && PATH_PROBE_BINARIES.has(commandBinary) && NO_SUCH_PATH_OUTPUT.test(output)) {
        resolve(pathProbeAnswer(commandBinary, code, output));
        return;
      }
      const truncated = output.length > 12_000 || stdout.truncated() || stderr.truncated();
      const enriched = enrichShellOutput(output, code);
      const baseResult: ToolResult = {
        ok: code === 0,
        summary: buildProcessSummary("Command", code, output, truncated),
        output: enriched,
      };
      resolve(code === 0 ? baseResult : { ...baseResult, error: enriched.slice(0, 2_000) });
    });
    child.on("error", (err) => {
      cleanup();
      resolve({ ok: false, summary: "Command failed to start.", error: err.message });
    });
  });
}

// grep/rg exit code 1 means "searched fine, zero matches"; 2+ is a real error.
// A no-match search is an ANSWER, not a failure — reporting it as failed makes
// the model re-run the same search and feeds the stall detectors a phantom
// failing check (observed: a run ground to the token backstop on a grep that
// legitimately had nothing to find). Normalized only for the conservative
// shape: a single search command (optionally after one `cd <dir> &&` hop),
// exit exactly 1, nothing on stderr. Pipelines/chains keep real exit
// semantics, and search probes never gate DoD anyway.
const SEARCH_NO_MATCH_BINARIES = new Set(["grep", "egrep", "fgrep", "zgrep", "rg", "ag"]);

// A trailing stderr/stdout redirect (`2>&1`, `2>/dev/null`, `>/dev/null 2>&1`)
// does NOT change a search's exit code — grep/rg still exit 1 on no-match. Strip
// them so `grep … 2>&1` (the exact shape that stalled a run: reported as a Shell
// failure, then re-run, then fed to the stall detector) is still recognized as a
// bare search. A redirect BEFORE a pipe/chain is left for the control-op scan to
// reject, because there the exit code genuinely belongs to something else.
function stripTrailingRedirects(script: string): string {
  let prev = "";
  let current = script.trim();
  while (prev !== current) {
    prev = current;
    current = current.replace(/\s+\d*>>?\s*(?:&[\d-]+|\/dev\/\w+)\s*$/, "").trim();
  }
  return current;
}

// Strips one leading `cd <dir> &&` hop and any trailing redirect, leaving the
// binary name and its argument text. Shared by isBareSearchInvocation (which
// only needs the boolean) and the run_shell no-match path (which also wants
// the binary + arg text for the literal-pipe hint).
function strippedSearchInvocation(text: string): { script: string; binary: string } {
  let script = text.trim();
  const cdPrefix = script.match(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/);
  if (cdPrefix) script = script.slice(cdPrefix[0].length).trim();
  script = stripTrailingRedirects(script);
  const binary = (script.split(/\s+/, 1)[0] ?? "").split("/").pop() ?? "";
  return { script, binary };
}

// Any unquoted control operator hands the exit code to something else.
function hasUnquotedControlOperator(script: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i] as string;
    if (quote) {
      if (ch === "\\" && quote === '"') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch as '"' | "'"; continue; }
    if (ch === "\\") { i += 1; continue; }
    if (ch === "|" || ch === ";" || ch === "&" || ch === ">" || ch === "<" || ch === "`") return true;
    if (ch === "$" && script[i + 1] === "(") return true;
  }
  return false;
}

function isBareSearchInvocation(text: string): boolean {
  const { script, binary } = strippedSearchInvocation(text);
  if (!SEARCH_NO_MATCH_BINARIES.has(binary)) return false;
  return !hasUnquotedControlOperator(script);
}

// Plain `grep`/`zgrep` use BRE by default, where a bare `|` is a LITERAL pipe
// character, not alternation — `grep "a|b"` searches for the three-character
// string "a|b", not "a" OR "b". A model composing `"launchStep|LaunchStep"`
// expecting OR gets a silent wrong-shaped search (observed: it read as "no
// matches" and the model retried variants instead of realizing the pattern
// never could have matched). `egrep`/`rg`/`ag` default to extended regex
// (alternation works); `fgrep`/`-F` is fixed-string (no regex metachars at
// all, so `|` there is correctly literal and needs no hint).
const PLAIN_BRE_GREP_BINARIES = new Set(["grep", "zgrep"]);

// GNU grep's BRE accepts `\|` as a portability extension for alternation, so
// only a BARE (unescaped) `|` is the trap. By the time this runs the caller has
// already confirmed (via isBareSearchInvocation) that no unquoted control
// operator reached the shell, so any `|` left in the raw script text is
// necessarily inside the quoted pattern.
function hasUnescapedPipe(text: string): boolean {
  return /(?<!\\)\|/.test(text);
}

// -E/--extended-regexp or -P/--perl-regexp make `|` real alternation;
// -F/--fixed-strings makes it literal on purpose. Any of the three means no
// hint is needed. Matched as whitespace-bounded flag-shaped tokens so this
// doesn't fire on those letters appearing inside the quoted pattern itself.
const GREP_ALTERNATION_OR_FIXED_FLAG = /(^|\s)-[A-Za-z]*[EPF][A-Za-z]*(?=\s|$)|--extended-regexp|--perl-regexp|--fixed-strings/;

export function literalPipeHint(binary: string, argsText: string): string | null {
  if (!PLAIN_BRE_GREP_BINARIES.has(binary)) return null;
  if (GREP_ALTERNATION_OR_FIXED_FLAG.test(argsText)) return null;
  if (!hasUnescapedPipe(argsText)) return null;
  return "Note: the pattern contains \"|\", which plain grep matches as a LITERAL pipe character — if you meant alternation (a OR b), re-run with `grep -E`.";
}

function searchNoMatchResult(hint: string | null = null): ToolResult {
  const base = 'Search completed with no matches (exit 1 from a search tool means "no matches", not an error). Do not re-run the same search; try a different pattern or location if needed.';
  return {
    ok: true,
    summary: hint ? `${base} ${hint}` : base,
    output: "No matches found.",
  };
}

// An existence probe on a missing path is an ANSWER, not a failure: `ls` and
// `stat` exit 1 (BSD) / 2 (GNU) with "No such file or directory" when the
// path is absent — which is often exactly what the probe was checking
// (observed live: a run looped on `ls -la <dir>/ 2>&1` verifying a cleanup,
// where exit 1 PROVED the cleanup had worked, until the stall backstop
// fired). Bare invocations only — chains/pipelines keep real exit semantics.
const PATH_PROBE_BINARIES = new Set(["ls", "stat"]);
const NO_SUCH_PATH_OUTPUT = /No such file or directory/i;

function pathProbeAnswer(binary: string, code: number, output: string): ToolResult {
  return {
    ok: true,
    summary: `Path does not exist — that IS this probe's answer (\`${binary}\` exiting ${code} with "No such file or directory" means the path is ABSENT, not that the command failed). Do not re-run the probe; proceed based on the absence.`,
    output,
  };
}

function missingPathProbeResult(script: string, code: number, output: string): ToolResult | null {
  if (code !== 1 && code !== 2) return null;
  if (!NO_SUCH_PATH_OUTPUT.test(output)) return null;
  const { script: stripped, binary } = strippedSearchInvocation(script);
  if (!PATH_PROBE_BINARIES.has(binary)) return null;
  if (hasUnquotedControlOperator(stripped)) return null;
  return pathProbeAnswer(binary, code, output);
}

// `cmd | grep pattern` exits with grep's status whenever grep is the
// rightmost nonzero exit — and grep exits 1 whenever it matches NOTHING.
// Under `set -o pipefail` (which unsafeMaskedVerification itself demands for
// piped build commands) that makes a CLEAN build indistinguishable from a
// broken one: both can surface as "Shell exited 1" with no output, and the
// model re-runs the identical command until the stall backstop (observed
// live, repeatedly: `xcodebuild … 2>&1 | grep -E "error:" | head -40`).
// Exit 1 + EMPTY output proves only "the filter matched nothing" — the
// upstream command's own status is masked. Say exactly that, with the
// disambiguating recipe, instead of a bare "Shell exited 1".
const PIPED_SEARCH_SEGMENT = /\|\s*(?:grep|egrep|fgrep|zgrep|rg|ag)\b/;

export function pipedSearchNoMatchSummary(script: string): string | null {
  if (!PIPED_SEARCH_SEGMENT.test(script)) return null;
  return 'Exit 1 with NO output from a grep-filtered pipeline means the FILTER matched nothing — it does NOT tell you whether the upstream command succeeded or failed (with pipefail, grep\'s no-match exit 1 masks the upstream status). Do not re-run the same command. Re-run keeping the verdict visible: include a success marker in the pattern (e.g. `grep -E "error:|BUILD (SUCCEEDED|FAILED)"`) or read the end of the output directly (`… 2>&1 | tail -30`).';
}

// A big failing build/test log defeats the model-facing head+tail
// truncation: xcodebuild emits megabytes of compile spam, the `error:` lines
// sit in the DROPPED MIDDLE, and the model is left with "exited 65" plus a
// list of failed files but no reasons — observed live: a run re-ran the same
// xcodebuild until the stall backstop, while three syntax errors sat
// invisible mid-log. For any non-ok result whose output is large enough to
// be truncated downstream, extract the error-shaped lines (deduped —
// xcodebuild repeats each) and PREPEND them, so every truncation window
// keeps them.
const KEY_ERROR_LINE = /(?:^|[\s/])(?:error|fatal error)\s*(?:TS\d+)?:|\*\* BUILD FAILED \*\*|\*\* TEST FAILED \*\*|^FAILURE:|Testing failed:/;
const KEY_ERROR_MIN_OUTPUT = 16_000;
const KEY_ERROR_MAX_LINES = 40;

export function keyErrorLinesBlock(output: string): string | null {
  if (output.length <= KEY_ERROR_MIN_OUTPUT) return null;
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const line of output.split("\n")) {
    if (!KEY_ERROR_LINE.test(line)) continue;
    const trimmed = line.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    picked.push(trimmed);
    if (picked.length >= KEY_ERROR_MAX_LINES) break;
  }
  if (picked.length === 0) return null;
  return [
    `## Key error lines (extracted; full ${output.length}-char output follows)`,
    ...picked,
  ].join("\n");
}

function withKeyErrorLines(output: string, code: number | null): string {
  if (code === 0 || code === null) return output;
  const block = keyErrorLinesBlock(output);
  return block ? `${block}\n\n${output}` : output;
}

// GNU-flag-on-BSD guidance (0.17.1-beta.29). Live stall: `sed … | cat -A`
// exits 1 on macOS ("cat: illegal option -- A") — a GNU coreutils habit, but
// Darwin's stock userland is BSD. The bare exit-1 reads as a mysterious
// failure and gets retried verbatim to the stall backstop. Keyed on the BSD
// tools' OWN error wording (never the command text), so it cannot
// false-fire: GNU getopt spells these "invalid option"/"unrecognized
// option '--x'" with different quoting, and a matching line only exists
// when the tool itself rejected the flag. Empirical wordings captured live:
//   cat: illegal option -- A            (short GNU flag)
//   stat: illegal option -- -           (any --long option; BSD reports `-`)
//   du: unrecognized option `--max-depth=1'
// The `unrecognized option` branch requires BSD's backtick-open quoting
// (`--flag'); GNU getopt quotes with straight quotes ('--flag') and spells
// short-flag rejections "invalid option", so Linux outputs never match.
const BSD_ILLEGAL_OPTION = /^([a-z0-9_.+-]+): (?:illegal option -- ?(\S+)|unrecognized option `(--[^\s'`]+))/m;

const BSD_TOOL_HINTS: Record<string, string> = {
  cat: "for invisible characters use `cat -evt` (line ends as $, tabs as ^I) — the BSD equivalent of GNU `cat -A`",
  date: "use `date -v+1d` (relative) or `date -j -f '<fmt>' '<input>'` (parse) — GNU `date -d` does not exist here",
  stat: "use `stat -f '<fmt>'` — GNU `stat --format`/`-c` does not exist here",
  du: "use `du -d <n>` — GNU `du --max-depth=<n>` does not exist here",
  sed: "BSD sed: in-place editing needs `sed -i '' <expr>` (empty backup suffix as its own argument)",
};

export function bsdFlagGuidance(output: string, code: number | null): string | null {
  if (code === null || code === 0) return null;
  const match = BSD_ILLEGAL_OPTION.exec(output);
  if (!match) return null;
  const tool = match[1]!;
  const flag = match[2] === "-" ? "a GNU-style --long option" : `\`${(match[2] ?? match[3] ?? "").replace(/=.*$/, "")}\``;
  const hint = BSD_TOOL_HINTS[tool]
    ?? `check \`man ${tool}\` for the BSD spelling of what you meant — GNU long options usually have a short BSD form`;
  return [
    `GNU-only flag on a BSD tool: \`${tool}\` rejected ${flag} — macOS ships BSD userland, not GNU coreutils.`,
    `Do NOT retry the same command; it fails identically every time. Instead: ${hint}.`,
  ].join("\n");
}

function withBsdFlagGuidance(output: string, code: number | null): string {
  const guidance = bsdFlagGuidance(output, code);
  return guidance ? `${guidance}\n\n${output}` : output;
}

// The shell-output enrichment pipeline, applied in order (later enrichers see
// earlier enrichers' output). New guidance stages register here so the
// process/shell call sites stay single-line instead of hand-nesting.
const SHELL_OUTPUT_ENRICHERS: Array<(output: string, code: number | null) => string> = [
  withKeyErrorLines,
  withBsdFlagGuidance,
];

function enrichShellOutput(output: string, code: number | null): string {
  return SHELL_OUTPUT_ENRICHERS.reduce((acc, enrich) => enrich(acc, code), output);
}

// Two live Tanya sessions can share one repository; git serializes index
// mutations with .git/index.lock, so an add/commit racing the other session
// fails transiently ("index.lock: File exists"). Retry briefly with backoff
// instead of surfacing a spurious failure the agent then chases in a loop.
const GIT_LOCK_RETRY_LIMIT = 4;
const GIT_LOCK_RETRY_BASE_DELAY_MS = 600;

function transientGitLockFailure(commandText: string, result: ToolResult): boolean {
  if (result.ok) return false;
  if (!/\bgit\b/.test(commandText)) return false;
  const output = `${typeof result.output === "string" ? result.output : ""}\n${result.error ?? ""}`;
  return /index\.lock['"]?:?\s*File exists|Another git process seems to be running/i.test(output);
}

export async function withGitLockRetry(commandText: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
  let result = await run();
  for (let attempt = 1; attempt <= GIT_LOCK_RETRY_LIMIT && transientGitLockFailure(commandText, result); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, GIT_LOCK_RETRY_BASE_DELAY_MS * attempt));
    result = await run();
  }
  return result;
}

function emitToolProgress(context: ToolContext, stream: "stdout" | "stderr", chunk: string): void {
  if (!context.onProgress || !chunk) return;
  try {
    void Promise.resolve(context.onProgress({
      stream,
      chunk,
      timestamp: new Date().toISOString(),
    })).catch(() => {});
  } catch {
    // Progress is observational; a sink failure must not fail the tool.
  }
}

function runShell(script: string, context: ToolContext, timeoutMs: number, cwd = context.workspace): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(SHELL_PATH, ["-lc", script], {
      cwd,
      shell: false,
      env: process.env,
      detached: process.platform !== "win32",
      // Non-interactive contract: scripts that read stdin get EOF immediately
      // instead of hanging on a never-closed pipe until the timeout.
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = makeCappedBuffer();
    const stderr = makeCappedBuffer();
    let cancelled = context.signal?.aborted ?? false;
    let cancelKillTimer: ReturnType<typeof setTimeout> | null = null;
    const progressBuffers: Record<"stdout" | "stderr", string> = {
      stdout: "",
      stderr: "",
    };
    const progressTimers: Record<"stdout" | "stderr", ReturnType<typeof setTimeout> | null> = {
      stdout: null,
      stderr: null,
    };
    const flushProgress = (stream: "stdout" | "stderr") => {
      const timer = progressTimers[stream];
      if (timer) clearTimeout(timer);
      progressTimers[stream] = null;
      const chunk = progressBuffers[stream];
      progressBuffers[stream] = "";
      emitToolProgress(context, stream, chunk);
    };
    const flushAllProgress = () => {
      flushProgress("stdout");
      flushProgress("stderr");
    };
    const queueProgress = (stream: "stdout" | "stderr", chunk: string) => {
      if (!context.onProgress || !chunk) return;
      progressBuffers[stream] += chunk;
      if (progressTimers[stream]) return;
      progressTimers[stream] = setTimeout(() => flushProgress(stream), getProgressThrottleMs());
      progressTimers[stream]?.unref?.();
    };
    const outputSoFar = () => {
      const stderrText = stderr.value();
      return `${stdout.value()}${stderrText ? `\n${stderrText}` : ""}`.trim();
    };
    const killShellProcess = (signal: NodeJS.Signals) => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to the direct child if the process group is already gone.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // Process already exited.
      }
    };
    const requestCancel = () => {
      cancelled = true;
      killShellProcess("SIGTERM");
      if (!cancelKillTimer) {
        cancelKillTimer = setTimeout(() => killShellProcess("SIGKILL"), 500);
        cancelKillTimer.unref?.();
      }
    };
    const cleanupShell = () => {
      clearTimeout(timer);
      if (cancelKillTimer) clearTimeout(cancelKillTimer);
      context.signal?.removeEventListener("abort", requestCancel);
      flushAllProgress();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timer = setTimeout(() => {
      killShellProcess("SIGTERM");
    }, timeoutMs);
    if (context.signal?.aborted) requestCancel();
    else context.signal?.addEventListener("abort", requestCancel, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout.append(text);
      queueProgress("stdout", text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr.append(text);
      queueProgress("stderr", text);
    });
    child.on("close", (code) => {
      cleanupShell();
      const output = outputSoFar();
      if (cancelled || context.signal?.aborted) {
        const partialOutput = summarizeProcessOutput(output, 16_000).text;
        resolve({
          ok: false,
          summary: "Shell cancelled by user. Partial output captured.",
          output: { cancelled: true, partial_output: partialOutput },
          error: "Shell cancelled by user.",
          cancelled: true,
          partial_output: partialOutput,
        });
        return;
      }
      if (code === 1 && !stderr.value().trim() && isBareSearchInvocation(script)) {
        const { script: strippedScript, binary } = strippedSearchInvocation(script);
        resolve(searchNoMatchResult(literalPipeHint(binary, strippedScript)));
        return;
      }
      const probeResult = code === null ? null : missingPathProbeResult(script, code, output);
      if (probeResult) {
        resolve(probeResult);
        return;
      }
      if (code === 1 && !output.trim()) {
        const pipedHint = pipedSearchNoMatchSummary(script);
        if (pipedHint) {
          resolve({ ok: false, summary: pipedHint, output, error: pipedHint });
          return;
        }
      }
      const truncated = output.length > 16_000 || stdout.truncated() || stderr.truncated();
      const enriched = enrichShellOutput(output, code);
      const baseResult: ToolResult = {
        ok: code === 0,
        summary: buildProcessSummary("Shell", code, output, truncated),
        output: enriched,
      };
      resolve(code === 0 ? baseResult : { ...baseResult, error: enriched.slice(0, 2_000) });
    });
    child.on("error", (err) => {
      cleanupShell();
      resolve({ ok: false, summary: "Shell failed to start.", error: err.message });
    });
  });
}

// The regex-based shell safety checks below (unsafeMaskedVerification,
// unsafeHostPackageMutation, and the inline guards in runShellTool.run) are
// ADVISORY ONLY. They are trivially bypassable via indirection (`eval $(cat)`,
// shell variables, `bash -c "..."`). The authoritative gate is the
// permissions engine in src/safety/permissions. Do not weaken or remove a
// permission rule on the assumption that these regexes already catch a case.
function unsafeMaskedVerification(script: string): string | null {
  const runsMobileBuildTool = /(?:^|[\s;&|])(?:\.\/gradlew|gradle|xcodebuild|fastlane)\b/.test(script);
  if (!runsMobileBuildTool) return null;
  const isReadOnlyXcodeDiscovery = /\bxcodebuild\s+-(?:list|showsdks|version)\b/i.test(script);
  if (isReadOnlyXcodeDiscovery) return null;
  if (/[|]/.test(script) && !/set\s+-o\s+pipefail/.test(script)) {
    return "Mobile build/test verification commands that use pipes must include `set -o pipefail` so failures are not masked.";
  }
  // The pipefail rule above creates its own trap: with pipefail set, a
  // `| grep "error:"`-style filter exits 1 whenever it matches nothing, so a
  // CLEAN build reads as a shell failure (observed stalling live runs on
  // green xcodebuild output). An error-hunting filter must keep the build
  // verdict visible so a green run still produces a match and exit 0.
  if (
    /set\s+-o\s+pipefail/.test(script) &&
    /\|\s*(?:grep|egrep|fgrep|zgrep|rg|ag)\b[^|]*error/i.test(script) &&
    !/succeeded|passed/i.test(script)
  ) {
    return 'Under `set -o pipefail`, a `| grep`-style error filter exits 1 whenever it matches nothing — a CLEAN build would read as a shell failure. Include the verdict in the pattern, e.g. `grep -E "error:|BUILD (SUCCEEDED|FAILED)"` (or your build tool\'s success marker), or read the output tail instead of filtering.';
  }
  if (/;\s*echo\s+["']?EXIT_CODE=\$\?["']?/i.test(script)) {
    return "Do not append `; echo EXIT_CODE=$?` to verification commands because it makes the shell exit 0 even when the build command failed.";
  }
  return null;
}

function unsafeHostPackageMutation(script: string): string | null {
  if (/\bbrew\s+(?:install|reinstall|upgrade|uninstall|tap|extract)\b/i.test(script)) {
    return "Host package-manager mutation is not allowed during coding runs. Report the missing/broken Homebrew package as a manual environment blocker instead.";
  }
  if (/\bgem\s+(?:install|update|uninstall)\b/i.test(script) || /\bbundle\s+install\b/i.test(script)) {
    return "Host Ruby gem mutation is not allowed during coding runs. Report the missing/broken Ruby/Fastlane dependency as a manual environment blocker instead.";
  }
  return null;
}

function summarizeProcessOutput(output: string, maxChars: number): { text: string; truncated: boolean } {
  if (output.length <= maxChars) return { text: output, truncated: false };
  const headSize = Math.floor(maxChars * 0.35);
  const tailSize = maxChars - headSize - 120;
  return {
    text: `${output.slice(0, headSize)}\n\n[output truncated: showing head and tail; exit code remains authoritative]\n\n${output.slice(-tailSize)}`,
    truncated: true,
  };
}

// A shell parse/syntax error (unbalanced quote/backtick/paren, bad substitution)
// means the shell NEVER RAN the command — retrying the identical string fails
// identically. Anchored to a leading shell-name prefix (`zsh:`, `bash:`, `sh:`)
// so a program that merely prints "syntax error" in its own output can't be
// mislabelled. Observed: an agent stalled re-running a grep with an unescaped
// backtick (`… struct|`json"`) that zsh rejected as `unmatched "`.
const SHELL_PARSE_ERROR =
  // The shell prefix is argv[0] verbatim: zsh prints a bare `zsh:`, but bash
  // echoes the full spawn path (`/bin/bash: -c: line 0: ...`) — allow both.
  /(?:^|\n)\s*(?:\S*\/)?(?:zsh|bash|sh|dash)[:\s][^\n]*\b(?:unmatched|parse error|bad substitution|unexpected EOF|syntax error|unexpected end of file)\b/i;

export function isShellParseError(output: string): boolean {
  return SHELL_PARSE_ERROR.test(output);
}

function buildProcessSummary(kind: "Command" | "Shell", code: number | null, output: string, truncated: boolean): string {
  const exit = code ?? "unknown";
  const truncatedHint = truncated ? " Output was truncated for display, but the exit code is authoritative." : "";
  // The command was never executed — a quoting/escaping bug, not a task failure.
  // Say so, so the agent fixes the command instead of retrying it verbatim.
  if (kind === "Shell" && code !== 0 && isShellParseError(output)) {
    return `Shell parse error — the command was NOT executed (unbalanced quote/backtick/paren or bad substitution). Fix the command's quoting/escaping; retrying the same string will fail identically.${truncatedHint}`;
  }
  const successHint = code === 0 && /BUILD SUCCEEDED|Test Suite '.+' passed|0 failures|Process completed successfully/i.test(output)
    ? " Success marker found."
    : "";
  return `${kind} exited ${exit}.${successHint}${truncatedHint}`;
}

function filterTypeScriptErrorOutput(output: unknown): string | null {
  if (typeof output !== "string" || !output.trim()) return null;
  const lines = output.split(/\r?\n/);
  const kept: string[] = [];
  const errorPattern = /^[^:]+\.tsx?:\d+:\d+\s+-\s+error\s+TS\d+:/;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!errorPattern.test(line)) continue;
    kept.push(line);
    const nextLine = lines[i + 1];
    if (nextLine !== undefined) kept.push(nextLine);
  }
  return kept.length > 0 ? `TypeScript errors (filtered):\n${kept.join("\n")}` : null;
}

function commandRunsTypeScript(command: string, args: string[]): boolean {
  return basename(command) === "tsc" || args.some((arg) => basename(arg) === "tsc");
}

function shellRunsTypeScript(script: string): boolean {
  return /(?:^|[\s;&|])(?:npx\s+|npm\s+exec\s+|pnpm\s+exec\s+|yarn\s+)?tsc(?:\s|$)/.test(script);
}

function maybeFilterTypeScriptErrorResult(result: ToolResult, shouldFilter: boolean): ToolResult {
  if (!shouldFilter || result.ok) return result;
  const filtered = filterTypeScriptErrorOutput(result.output);
  if (!filtered) return result;
  return {
    ...result,
    output: filtered,
    error: filtered,
  };
}

export function normalizeRelativePathForGit(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

export function ensureRelativePath(path: string): string {
  if (path.startsWith("/")) throw new Error(`Path must be relative to the workspace: ${path}`);
  return path;
}

function resolveToolCwd(context: ToolContext, cwdInput?: string): string {
  if (!cwdInput) return context.workspace;
  return isAbsolute(cwdInput)
    ? resolveInsideWorkspace(context.workspace, cwdInput)
    : resolveInsideWorkspace(context.workspace, ensureRelativePath(cwdInput));
}

function runProcessWithInput(
  command: string,
  args: string[],
  input: string,
  context: ToolContext,
  timeoutMs: number,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: context.workspace,
      shell: false,
      env: processEnvWithStandardPath(),
    });
    const stdout = makeCappedBuffer();
    const stderr = makeCappedBuffer();
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk.toString());
    });
    child.on("close", (code) => {
      cleanup();
      const stderrText = stderr.value();
      const output = `${stdout.value()}${stderrText ? `\n${stderrText}` : ""}`.trim();
      const baseResult: ToolResult = {
        ok: code === 0,
        summary: `Command exited ${code ?? "unknown"}.`,
        output: output.slice(0, 12_000),
      };
      resolve(code === 0 ? baseResult : { ...baseResult, error: output.slice(0, 2_000) });
    });
    child.on("error", (err) => {
      cleanup();
      resolve({ ok: false, summary: "Command failed to start.", error: err.message });
    });
    child.stdin.end(input);
  });
}

function stripPatchPath(path: string, stripLevel: number): string | null {
  const clean = path.trim().split(/\s+/)[0];
  if (!clean || clean === "/dev/null") return null;
  const withoutQuotes = clean.replace(/^"|"$/g, "");
  const parts = withoutQuotes.split("/").filter(Boolean);
  const stripped = parts.slice(Math.max(0, stripLevel)).join("/");
  return stripped || withoutQuotes;
}

function inferPatchStripLevel(patch: string): number {
  return /^diff --git a\//m.test(patch) || /^--- a\//m.test(patch) || /^\+\+\+ b\//m.test(patch) ? 1 : 0;
}

function extractPatchFiles(patch: string, stripLevel: number): string[] {
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    const header = /^(?:---|\+\+\+)\s+(.+)$/.exec(line);
    if (!header) continue;
    const stripped = stripPatchPath(header[1] ?? "", stripLevel);
    if (stripped) files.add(stripped);
  }
  return [...files];
}

async function removePatchBackupFiles(files: string[], context: ToolContext): Promise<string[]> {
  const removed: string[] = [];
  for (const file of files) {
    for (const suffix of [".orig", ".bak"]) {
      const backupPath = `${file}${suffix}`;
      try {
        const abs = resolveInsideWorkspace(context.workspace, backupPath);
        await unlink(abs);
        removed.push(backupPath);
      } catch {
        // No backup was created for this file.
      }
    }
  }
  return removed;
}

// Resolve symlinks so the boundary check is correct on macOS, where the
// worktree's real path is /private/var/folders/... but $TMPDIR-derived
// workspace roots are stored as the /var/folders/... symlink form. A purely
// lexical relative() between those yields a "../"-prefixed path and falsely
// flags an in-workspace write (e.g. `cd <abs-worktree> && echo … >> .gitignore`)
// as "outside workspace". Canonicalizing both sides fixes that without
// weakening the guard — a genuinely-outside path still resolves outside.
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return resolve(p);
    try {
      return join(realpathSync(parent), basename(p));
    } catch {
      return resolve(p);
    }
  }
}

function pathInsideWorkspace(workspace: string, target: string): boolean {
  const rel = relative(canonicalPath(workspace), canonicalPath(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function shellUnquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function shellSnippetMayMutateWorkspace(script: string): boolean {
  return /(?:^|[;&|]\s*)(?:cat\s+>|tee\s+|mkdir\b|touch\b|rm\b|mv\b|cp\b|ln\b|go\s+mod\s+(?:init|tidy|edit|download)\b|go\s+get\b|go\s+work\b|npm\s+(?:install|i|update|add)\b|pnpm\s+(?:install|add|update)\b|yarn\s+(?:add|install)\b|sqlc\s+generate\b|go\s+run\s+github\.com\/sqlc-dev\/sqlc\/cmd\/sqlc(?:@\S+)?\s+generate\b|git\s+(?:add|commit|rm|mv|checkout|restore|reset|clean)\b)/i.test(script) ||
    /(?:^|[^2])>\s*(?!&)/.test(script);
}

export function outsideWorkspaceShellMutationError(script: string, workspace: string, cwd: string): string | null {
  const match = script.match(/^\s*cd\s+((?:"[^"]+")|(?:'[^']+')|(?:\S+))\s*&&\s*([\s\S]+)$/);
  if (!match) return null;
  const rawTarget = shellUnquote(match[1] ?? "");
  if (!rawTarget || rawTarget === "-") return null;
  if (/[$`]/.test(rawTarget)) return null;
  const target = isAbsolute(rawTarget) ? resolve(rawTarget) : resolve(cwd, rawTarget);
  if (pathInsideWorkspace(workspace, target)) return null;
  const rest = match[2] ?? "";
  if (!shellSnippetMayMutateWorkspace(rest)) return null;
  return `Shell snippet changes directory outside the workspace before a mutating command: cd ${rawTarget}. Use structured file tools or run mutations from the workspace root.`;
}

export const listFilesTool: TanyaTool = {
  name: "list_files",
  description: "List workspace files, skipping dependency and build directories.",
  definition: {
    type: "function",
    function: {
      name: "list_files",
      description: "List workspace files, skipping dependency and build directories.",
      parameters: {
        type: "object",
        properties: {
          maxFiles: { type: "number", description: "Maximum number of files to return. Default 120." },
          path: { type: "string", description: "Optional directory path relative to the workspace. Default workspace root." },
        },
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const maxFiles = Math.min(asOptionalNumber(input, "maxFiles", 120), 500);
    const path = asOptionalString(input, "path");
    const root = path ? resolveInsideWorkspace(context.workspace, ensureRelativePath(path)) : context.workspace;
    const files = collectFiles(root, maxFiles).map((file) => path ? `${path.replace(/\/+$/, "")}/${file}` : file);
    return { ok: true, summary: `Listed ${files.length} file${files.length === 1 ? "" : "s"}.`, output: files };
  },
};

export const readFileTool: TanyaTool = {
  name: "read_file",
  description: "Read a UTF-8 text file inside the workspace.",
  truncateLargeResults: false,
  definition: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace." },
          maxChars: { type: "number", description: "Maximum characters to return. Default 12000." },
          force: { type: "boolean", description: "Return full content even if Tanya already read the same unchanged file in this run." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const path = asString(input, "path");
    const maxChars = Math.min(asOptionalNumber(input, "maxChars", 12_000), 40_000);
    const abs = resolveInsideWorkspace(context.workspace, path);
    const content = await readFile(abs, "utf8");
    return {
      ok: true,
      summary: `Read ${path}.`,
      output: content.length > maxChars ? `${content.slice(0, maxChars)}\n[truncated]` : content,
    };
  },
};

export const writeFileTool: TanyaTool = {
  name: "write_file",
  description: "Write a UTF-8 text file inside the workspace.",
  definition: {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a UTF-8 text file inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace." },
          content: { type: "string", description: "Full file content." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const path = asString(input, "path");
    const content = asString(input, "content");
    if (isProtectedLocalConfigPath(path)) return localPropertiesWriteError();
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_WRITE_FILE_BYTES) {
      return {
        ok: false,
        summary: `Refused write to ${path}: content is ${bytes} bytes (cap ${MAX_WRITE_FILE_BYTES}).`,
        error: `write_file rejects payloads larger than ${MAX_WRITE_FILE_BYTES} bytes to avoid OOM/disk-fill. Split the file or stream it via run_shell.`,
      };
    }
    const abs = resolveInsideWorkspace(context.workspace, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    const previewLines = content.split("\n");
    const lineCount = previewLines.length;
    const preview = previewLines.slice(0, 4).join("\n");
    return {
      ok: true,
      summary: `Wrote ${path} (${lineCount} lines).`,
      output: { path, lineCount, preview },
      files: [path],
    };
  },
};

export const searchTool: TanyaTool = {
  name: "search",
  description: "Search workspace text using ripgrep.",
  definition: {
    type: "function",
    function: {
      name: "search",
      description: "Search workspace text using ripgrep.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query or regex." },
          maxResults: { type: "number", description: "Maximum lines to return. Default 80." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const query = asString(input, "query");
    const maxResults = Math.min(asOptionalNumber(input, "maxResults", 80), 300);
    const result = await runProcess("rg", ["-n", "--hidden", "-g", "!node_modules", "-g", "!.git", query], context, 20_000);
    if (!result.ok && typeof result.output === "string" && !result.output) {
      return { ok: true, summary: "No matches.", output: [] };
    }
    const lines = String(result.output ?? "").split("\n").slice(0, maxResults);
    return { ok: true, summary: `Found ${lines.filter(Boolean).length} match line${lines.length === 1 ? "" : "s"}.`, output: lines };
  },
};

export const runCommandTool: TanyaTool = {
  name: "run_command",
  description: "Run a non-interactive command inside the workspace.",
  keepFullForVerifier: true,
  definition: {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a non-interactive command inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command binary, for example npm." },
          args: { type: "array", items: { type: "string" }, description: "Command arguments." },
          cwd: { type: "string", description: "Optional subdirectory relative to the workspace." },
          timeoutMs: { type: "number", description: "Timeout in milliseconds. Default 120000, max 600000." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const command = asString(input, "command");
    const rawArgs = asRecord(input).args;
    const args = Array.isArray(rawArgs) ? rawArgs.filter((arg): arg is string => typeof arg === "string") : [];
    const cwdInput = asOptionalString(input, "cwd");
    const cwd = resolveToolCwd(context, cwdInput);
    const timeoutMs = Math.min(asOptionalNumber(input, "timeoutMs", 120_000), 600_000);
    const result = await withGitLockRetry([command, ...args].join(" "), () => runProcess(command, args, context, timeoutMs, cwd));
    return maybeFilterTypeScriptErrorResult(result, commandRunsTypeScript(command, args));
  },
};

export const runShellTool: TanyaTool = {
  name: "run_shell",
  description: "Run a bounded non-interactive shell snippet inside the workspace.",
  keepFullForVerifier: true,
  definition: {
    type: "function",
    function: {
      name: "run_shell",
      description: "Run a bounded non-interactive shell snippet inside the workspace. Use for mobile verification commands that need environment variables, pipes, or chained arguments.",
      parameters: {
        type: "object",
        properties: {
          script: { type: "string", description: "Non-interactive zsh script." },
          command: { type: "string", description: "Alias for script. Prefer script for new calls." },
          cwd: { type: "string", description: "Optional subdirectory relative to the workspace." },
          timeoutMs: { type: "number", description: "Timeout in milliseconds. Default 120000, max 600000." },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const script = asOptionalString(input, "script") ?? asString(input, "command");
    if (/\b(rm\s+-rf|sudo|ssh|scp|curl\s+[^|>]*\|\s*(?:sh|bash|zsh)|while\s+true|tail\s+-f)\b/.test(script)) {
      return shellSafetyBlock("Shell script rejected by safety checks.", "Use bounded, non-destructive, non-interactive commands only.");
    }
    if (
      /\bgit\s+show\s+\S+:[^\s|]+\s*>/.test(script) ||
      /\bgit\s+cat-file\s+-p\s+\S+:[^\s|]+\s*>/.test(script) ||
      /\bgit\s+(?:checkout|restore)\s+[^-\s][^\s]*\s+(?:--\s+)?\S/.test(script)
    ) {
      return shellSafetyBlock("Shell script rejected: git restore of historical content is not allowed.", "Do not use 'git show <ref>:<path> >', 'git cat-file -p <ref>:<path> >', or 'git checkout/restore <ref> -- <path>' to recover deleted files. Implement the file fresh using write_file/apply_patch following the artifacts and brief.");
    }
    if (/\bgit\s+(?:-C\s+\S+\s+)?reset\b/i.test(script)) {
      return { ok: false, summary: "Shell script rejected: git reset is not allowed.", error: "Do not use git reset during coding runs. Use commit_platform_changes with amend: true for task commit repairs, or edit files directly with workspace tools." };
    }
    const hostPackageMutationError = unsafeHostPackageMutation(script);
    if (hostPackageMutationError) {
      return { ok: false, summary: "Shell script rejected by host mutation safety checks.", error: hostPackageMutationError };
    }
    const maskedVerificationError = unsafeMaskedVerification(script);
    if (maskedVerificationError) {
      return shellSafetyBlock("Shell verification rejected by safety checks.", maskedVerificationError);
    }
    if (/(?:>\s*["']?[^&|;\n]*local\.properties\b|tee\s+[^|;\n]*local\.properties\b)/.test(script)) {
      return localPropertiesWriteError();
    }
    const cwdInput = asOptionalString(input, "cwd");
    const cwd = resolveToolCwd(context, cwdInput);
    const outsideMutationError = outsideWorkspaceShellMutationError(script, context.workspace, cwd);
    if (outsideMutationError) {
      return { ok: false, summary: "Shell script rejected: mutation outside workspace.", error: outsideMutationError };
    }
    const timeoutMs = Math.min(asOptionalNumber(input, "timeoutMs", 120_000), 600_000);
    const result = await withGitLockRetry(script, () => runShell(script, context, timeoutMs, cwd));
    return maybeFilterTypeScriptErrorResult(result, shellRunsTypeScript(script));
  },
};

export const applyPatchTool: TanyaTool = {
  name: "apply_patch",
  description: "Apply a unified diff patch inside the workspace.",
  definition: {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Apply a unified diff patch inside the workspace. Prefer this for existing file edits.",
      parameters: {
        type: "object",
        properties: {
          patch: { type: "string", description: "Unified diff patch text." },
          stripLevel: { type: "number", description: "Path strip level for patch. Defaults to auto-detect." },
        },
        required: ["patch"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const patch = asString(input, "patch");
    const explicitStrip = asOptionalNumber(input, "stripLevel", Number.NaN);
    const stripLevel = Number.isFinite(explicitStrip) ? explicitStrip : inferPatchStripLevel(patch);
    const files = extractPatchFiles(patch, stripLevel);
    if (files.length === 0) {
      return { ok: false, summary: "Patch contains no file headers.", error: "Expected unified diff headers." };
    }
    try {
      for (const file of files) {
        if (isProtectedLocalConfigPath(file)) return { ...localPropertiesWriteError(), files };
        resolveInsideWorkspace(context.workspace, file);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, summary: "Patch rejected by workspace safety checks.", error: message, files };
    }

    const result = await runProcessWithInput(
      "patch",
      [`-p${stripLevel}`, "--batch", "--forward", "--reject-file=-"],
      patch,
      context,
      60_000,
    );
    const output = typeof result.output === "string" ? result.output : "";
    if (!result.ok) {
      return {
        ...result,
        summary: "Patch failed.",
        files,
      };
    }
    const removedBackups = await removePatchBackupFiles(files, context);
    const backupNote = removedBackups.length > 0
      ? ` Removed patch backup file${removedBackups.length === 1 ? "" : "s"}: ${removedBackups.join(", ")}.`
      : "";
    return {
      ok: true,
      summary: `Applied patch to ${files.length} file${files.length === 1 ? "" : "s"}.${backupNote}`,
      output,
      files,
    };
  },
};

export const searchReplaceTool: TanyaTool = {
  name: "search_replace",
  description: "Replace an exact string in a file. Fails if the string is not found or appears more times than expected.",
  definition: {
    type: "function",
    function: {
      name: "search_replace",
      description: "Replace an exact string in a file inside the workspace. Prefer this over apply_patch for targeted single-location edits. Fails if old_string is not found or appears more times than expected_count.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the workspace." },
          old_string: { type: "string", description: "Exact string to find. Must be unique in the file unless expected_count is set." },
          new_string: { type: "string", description: "Replacement string." },
          expected_count: { type: "number", description: "How many occurrences to replace. Default 1. Use to allow replacing multiple occurrences." },
        },
        required: ["path", "old_string", "new_string"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const path = asString(input, "path");
    const oldString = asString(input, "old_string");
    const newString = asRecord(input).new_string;
    if (typeof newString !== "string") throw new Error("Missing string field: new_string");
    const expectedCount = asOptionalNumber(input, "expected_count", 1);
    if (isProtectedLocalConfigPath(path)) return localPropertiesWriteError();
    let abs: string;
    try {
      abs = resolveInsideWorkspace(context.workspace, path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, summary: "Path rejected by workspace safety checks.", error: message };
    }
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      return { ok: false, summary: `File not found: ${path}`, error: `Cannot read ${path}` };
    }
    const count = content.split(oldString).length - 1;
    if (count === 0) {
      return { ok: false, summary: "old_string not found in file.", error: `The exact string was not found in ${path}. Re-read the file and adjust old_string to match exactly.` };
    }
    if (count !== expectedCount) {
      return { ok: false, summary: `old_string appears ${count} time${count === 1 ? "" : "s"}, expected ${expectedCount}.`, error: `Found ${count} occurrence${count === 1 ? "" : "s"} in ${path}. Set expected_count: ${count} to replace all, or make old_string more specific.` };
    }
    const updated = content.split(oldString).join(newString);
    await writeFile(abs, updated, "utf8");
    const written = await readFile(abs, "utf8");
    const lines = written.split("\n");
    const lineCount = lines.length;
    const firstNewLine = newString.split("\n")[0] ?? "";
    const matchNeedle = firstNewLine.trim();
    const matchIdx = matchNeedle
      ? lines.findIndex((line) => line.includes(matchNeedle))
      : -1;
    const contextLines = matchIdx >= 0
      ? lines.slice(Math.max(0, matchIdx - 1), matchIdx + 3).join("\n")
      : "";
    return {
      ok: true,
      summary: `Replaced ${count} occurrence${count === 1 ? "" : "s"} in ${path} (${lineCount} lines).`,
      output: { path, count, lineCount, context: contextLines },
      files: [path],
    };
  },
};

export const copyFileTool: TanyaTool = {
  name: "copy_file",
  description: "Copy one file inside the workspace, including binary assets.",
  definition: {
    type: "function",
    function: {
      name: "copy_file",
      description: "Copy one file inside the workspace, including binary assets.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source path relative to the workspace." },
          destination: { type: "string", description: "Destination path relative to the workspace." },
          overwrite: { type: "boolean", description: "Overwrite destination if it exists. Default true." },
        },
        required: ["source", "destination"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const source = ensureRelativePath(asString(input, "source"));
    const destination = ensureRelativePath(asString(input, "destination"));
    const overwrite = asRecord(input).overwrite !== false;
    const sourceAbs = resolveInsideWorkspace(context.workspace, source);
    const destinationAbs = resolveInsideWorkspace(context.workspace, destination);
    await mkdir(dirname(destinationAbs), { recursive: true });
    await cp(sourceAbs, destinationAbs, { force: overwrite, errorOnExist: !overwrite });
    return { ok: true, summary: `Copied ${source} to ${destination}.`, output: { source, destination }, files: [destination] };
  },
};

export const copyDirTool: TanyaTool = {
  name: "copy_dir",
  description: "Copy a directory inside the workspace, including binary assets.",
  definition: {
    type: "function",
    function: {
      name: "copy_dir",
      description: "Copy a directory inside the workspace, including binary assets.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source directory relative to the workspace." },
          destination: { type: "string", description: "Destination directory relative to the workspace." },
          overwrite: { type: "boolean", description: "Overwrite destination files if they exist. Default true." },
        },
        required: ["source", "destination"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const source = ensureRelativePath(asString(input, "source"));
    const destination = ensureRelativePath(asString(input, "destination"));
    const overwrite = asRecord(input).overwrite !== false;
    const sourceAbs = resolveInsideWorkspace(context.workspace, source);
    const destinationAbs = resolveInsideWorkspace(context.workspace, destination);
    await cp(sourceAbs, destinationAbs, { recursive: true, force: overwrite, errorOnExist: !overwrite });
    return { ok: true, summary: `Copied directory ${source} to ${destination}.`, output: { source, destination }, files: [destination] };
  },
};

const secretFileExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".env", ".example", ".md", ".swift", ".kt", ".kts", ".gradle", ".rb", ".yml", ".yaml"]);

function looksLikeSecret(line: string): boolean {
  if (/placeholder|example|changeme|your_|<[^>]+>|\$\{|process\.env|env\(/i.test(line)) return false;
  return /\b[A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|private[_-]?key|client[_-]?secret|database_url)[A-Za-z0-9_-]*\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i.test(line);
}

export const scanSecretsTool: TanyaTool = {
  name: "scan_secrets",
  description: "Scan workspace text files for likely hardcoded secrets.",
  definition: {
    type: "function",
    function: {
      name: "scan_secrets",
      description: "Scan workspace text files for likely hardcoded secrets while ignoring obvious placeholders.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to workspace. Default workspace root." },
          maxFiles: { type: "number", description: "Maximum files to scan. Default 500." },
        },
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const scanPath = asOptionalString(input, "path");
    const maxFiles = Math.min(asOptionalNumber(input, "maxFiles", 500), 2000);
    const root = scanPath ? resolveInsideWorkspace(context.workspace, ensureRelativePath(scanPath)) : context.workspace;
    const files = collectFiles(root, maxFiles);
    const findings: Array<{ file: string; line: number; key: string }> = [];
    for (const file of files) {
      const lower = file.toLowerCase();
      if (!secretFileExtensions.has(lower.slice(lower.lastIndexOf(".")))) continue;
      let text = "";
      try {
        text = await readFile(resolveInsideWorkspace(root, file), "utf8");
      } catch {
        continue;
      }
      text.split(/\r?\n/).forEach((line, index) => {
        if (!looksLikeSecret(line)) return;
        const key = line.match(/\b([A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|private[_-]?key|client[_-]?secret|database_url)[A-Za-z0-9_-]*)\b/i)?.[1] ?? "secret";
        findings.push({ file: scanPath ? `${scanPath.replace(/\/+$/, "")}/${file}` : file, line: index + 1, key });
      });
    }

    return {
      ok: findings.length === 0,
      summary: findings.length === 0 ? "No likely hardcoded secrets found." : `Found ${findings.length} likely hardcoded secret${findings.length === 1 ? "" : "s"}.`,
      output: { findings },
      ...(findings.length > 0 ? { error: findings.map((finding) => `${finding.file}:${finding.line} ${finding.key}`).join("; ") } : {}),
    };
  },
};

export function defaultTools(): TanyaTool[] {
  const verificationPreferredModel = {
    provider: "deepseek",
    model: "deepseek-reasoner",
    match: "verification" as const,
  };
  const tools = [
    listFilesTool,
    expandResultTool,
    taskTool,
    ...subagentTools(),
    readFileTool,
    searchTool,
    inspectRepoMapTool,
    inspectProjectContextTool,
    findReusableArtifactsTool,
    buildTaskBriefTool,
    searchObsidianNotesTool,
    updatePlanTool,
    writeFileTool,
    applyPatchTool,
    editBlockTool,
    searchReplaceTool,
    copyFileTool,
    copyDirTool,
    applyArtifactTool,
    createIosSplashTool,
    createAndroidSplashTool,
    generateAppIconsTool,
    createAndroidFoundationTool,
    commitPlatformChangesTool,
    resizeImageTool,
    renderSvgToPngTool,
    createAppleAppIconSetTool,
    createAndroidLauncherIconSetTool,
    validateAppleAppIconSetTool,
    validateAndroidLauncherIconSetTool,
    validateApiContractRoutesTool,
    validateAndroidProjectConfigTool,
    validateAppleProjectFilesTool,
    validateFastlaneConfigTool,
    validatePrismaSchemaTool,
    scanSecretsTool,
    generateVideoAssetTool,
    recordMetricsDashboardHandoffTool,
    readImageTool,
    webSearchTool,
    fetchUrlTool,
    runCommandTool,
    runShellTool,
  ].map((tool): TanyaTool => (
    /^validate_/.test(tool.name) || tool.name === "scan_secrets"
      ? { ...tool, preferredModel: verificationPreferredModel }
      : tool
  ));
  return tools.filter((tool) => tool.name !== "search" || existsSync("/usr/bin/rg") || existsSync("/opt/homebrew/bin/rg") || existsSync("/usr/local/bin/rg"));
}
