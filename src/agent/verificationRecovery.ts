// Verification-recovery classification: decides which failed verification
// lines are real gating blockers and which were exploratory probes,
// bootstrap attempts, or failures later superseded by an authoritative
// green build. Salvaged from F-fix.5+8 WIP; extracted from report.ts (R2b).
// This module must stay import-free of report.ts (report imports it).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Salvaged from F-fix.5+8 WIP — reclassifies exploratory verification
// failures as "recovered" when the final-state verifier's authoritative
// checks have passed. Lets the report show "this build/test passed" even
// when intermediate probes failed during the run.
function isRecoverableBootstrapAttempt(command: string): boolean {
  return /^\s*(?:git\s+(?:-C\s+\S+\s+)?rm\b|mkdir\s+|sed\s+-i\b|cat\s+>|go\s+mod\s+init\b)/i.test(command);
}

// Read-only / diagnostic probes that never represent a code-correctness gate:
// file inspection, existence checks, and tool/version detection. A failed probe
// (`which fastlane`, `xcodebuild -version`, `test -f …`, `ls …`) says nothing
// about whether the code is correct — the authoritative build is the gate. These
// are dropped as blockers when the run has a passing authoritative build (see
// the exploratory-failure cleanup), so a flaky/absent diagnostic never produces
// a false FAIL on a green build. Real quality gates (build/test/lint) are NOT
// matched here and still gate.
function isRecoverableProbeCommand(command: string): boolean {
  return (
    // inspection + existence (incl. archive/jar inspection like `jar tf …`)
    /^\s*(?:cat|head|tail|sed\s+-n|ls|find|locate|stat|file|test|printenv|grep|rg|jar|unzip)\b/i.test(command) ||
    /^\s*\[\s/.test(command) ||                 // `[ -f path ]`
    // tool / version detection
    /^\s*(?:which|type|hash)\b/i.test(command) ||
    /^\s*command\s+-v\b/i.test(command) ||
    /(?:^|\s)--?version\b/i.test(command) ||    // `tool --version` / `tool -version`
    /^\s*\S+\s+version\b/i.test(command)        // `swiftlint version`, `go version`, …
  );
}

const PROBE_COMMANDS = new Set([
  "go vet",
  "go build",
  "go test",
  "grep",
  "rg",
  "ls",
  "cat",
  "head",
  "tail",
  "find",
  "locate",
  "jar",
  "unzip",
]);

function isProbeCommand(command: string): boolean {
  const localCommand = localExecutableCommand(command);
  const [first = "", second = ""] = localCommand.trim().split(/\s+/, 2);
  if (first === "go") return PROBE_COMMANDS.has(`go ${second}`);
  return PROBE_COMMANDS.has(first);
}

function isRecoverableGeneratorCommand(command: string): boolean {
  return /\b(?:sqlc|go\s+run\s+github\.com\/sqlc-dev\/sqlc\/cmd\/sqlc(?:@\S+)?)\s+generate\b/i.test(command);
}

function isRecoverableToolInstallCommand(command: string): boolean {
  return /\bgo\s+install\s+github\.com\/(?:sqlc-dev\/sqlc\/cmd\/sqlc|pressly\/goose\/v3\/cmd\/goose)(?:@\S+)?\b/i.test(command);
}

function commandAfterLeadingCd(command: string): string {
  const match = command.match(/^\s*cd\s+((?:"[^"]+")|(?:'[^']+')|(?:\S+))\s*&&\s*([\s\S]+)$/);
  return (match?.[2] ?? command).trim();
}

// Strips leading shell-option statements (`set -o pipefail;`, `set -euo pipefail;`,
// `set -e;`, `set +e;`, …) so the executable that follows can be probe-matched.
// Without this, a probe wrapped as `set -o pipefail; find / … | head` is read as
// the `set` builtin and never recognized as a diagnostic probe — producing a
// false FAIL on a green build (e.g. a `find …/com.revenuecat… .jar` SDK probe).
function stripLeadingShellOptions(command: string): string {
  let c = command.trim();
  for (let i = 0; i < 5; i += 1) {
    const m = c.match(/^set\s+[-+][^;\n]*[;\n]\s*([\s\S]+)$/i);
    if (!m?.[1]) break;
    c = m[1].trim();
  }
  return c;
}

// The actual executable to classify: after any leading `cd … &&` and any leading
// `set …;` shell-option statements.
function localExecutableCommand(command: string): string {
  return stripLeadingShellOptions(commandAfterLeadingCd(command));
}

function failedVerificationCommand(blocker: string): string | null {
  const raw = blocker
    .replace(/^failed verification:\s*/i, "")
    .replace(/^Verification:\s*/i, "");
  const match = raw.match(/^(.*?)\s*->\s*failed\b/i);
  const command = (match?.[1] ?? raw).trim();
  return command.length > 0 ? command : null;
}

function verificationCommand(line: string): string | null {
  const raw = line
    .replace(/^failed verification:\s*/i, "")
    .replace(/^Verification:\s*/i, "");
  const match = raw.match(/^(.*?)\s*->\s*(?:failed|passed|recovered)\b/i);
  const command = match?.[1]?.trim() ?? "";
  return command.length > 0 ? command : null;
}

function lastVerificationCommand(verificationLines: string[]): { command: string; failed: boolean } | null {
  for (let i = verificationLines.length - 1; i >= 0; i -= 1) {
    const line = verificationLines[i] ?? "";
    const command = verificationCommand(line);
    if (!command) continue;
    return { command, failed: /->\s*failed\b/i.test(line) };
  }
  return null;
}

export function isLastFailedProbeVerificationBlocker(blocker: string, verificationLines: string[]): boolean {
  if (!/^failed verification:/i.test(blocker)) return false;
  const blockerCommand = failedVerificationCommand(blocker);
  if (!blockerCommand || !isProbeCommand(blockerCommand)) return false;
  const lastCommand = lastVerificationCommand(verificationLines);
  return Boolean(lastCommand?.failed && normalizeVerificationCommand(blockerCommand) === normalizeVerificationCommand(lastCommand.command));
}

export function isExploratoryVerificationBlocker(blocker: string): boolean {
  if (!/^failed verification:/i.test(blocker)) return false;
  const command = failedVerificationCommand(blocker);
  if (!command) return false;
  const localCommand = localExecutableCommand(command);
  return (
    isRecoverableBootstrapAttempt(localCommand) ||
    isRecoverableProbeCommand(localCommand) ||
    isRecoverableGeneratorCommand(localCommand) ||
    isRecoverableToolInstallCommand(localCommand)
  );
}

export function reclassifyExploratoryFailuresAsRecovered(verificationLines: string[]): string[] {
  return verificationLines.map((line) => {
    if (!/->\s*failed/i.test(line)) return line;
    const command = failedVerificationCommand(line);
    if (!command) return line;
    const localCommand = commandAfterLeadingCd(command);
    const recoverable =
      isRecoverableBootstrapAttempt(localCommand) ||
      isRecoverableProbeCommand(localCommand) ||
      isRecoverableGeneratorCommand(localCommand) ||
      isRecoverableToolInstallCommand(localCommand);
    if (!recoverable) return line;
    return line.replace(/->\s*failed[^\n]*/i, "-> recovered (exploratory step; authoritative build/verification passed)");
  });
}

// Path globs for files the gate should scan even on verification-only runs.
// Kept narrow so we don't blow up cost on large repos: just route handlers
// for auth/billing/webhooks/email/notifications and the matching mobile
// session/auth/payment files. Project-level overrides in
// .tanya/forbidden-patterns.json `alwaysScanGlobs` (future).
const SECURITY_CRITICAL_PATH_PATTERNS: RegExp[] = [
  /(?:^|\/)(?:app|src)\/api\/(?:auth|billing|webhooks|payment|email|notifications)\/.*\.(?:ts|tsx|js|mjs)$/i,
  /(?:^|\/)routes\/(?:auth|billing|webhooks|payment|email|notifications)\/.*\.(?:ts|tsx|js|mjs|py|rb|go)$/i,
  // Mobile auth/billing files where placeholders cause silent prod failures
  /(?:^|\/)SessionStore\.swift$/i,
  /(?:^|\/)(?:APIClient|ApiClient|RevenueCatManager)\.swift$/i,
  /(?:^|\/)(?:AuthRepository|RevenueCatBilling)\.kt$/i,
  /(?:^|\/)values\/strings\.xml$/i,
];

export async function listSecurityCriticalTrackedFiles(workspace: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files"], {
      cwd: workspace,
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const all = stdout.split(/\r?\n/).filter(Boolean);
    return all.filter((file) => SECURITY_CRITICAL_PATH_PATTERNS.some((pattern) => pattern.test(file)));
  } catch {
    return [];
  }
}

export function normalizeVerificationCommand(line: string): string {
  return line
    .replace(/^Verification:\s*/i, "")
    .replace(/\s*->\s*(passed|failed|BUILD SUCCESSFUL|BUILD FAILED|blocked|.+)$/i, "")
    .replace(/\s+2>&1\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function successfulVerificationCommands(text: string): Set<string> {
  const commands = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!/^Verification:\s*/i.test(line)) continue;
    if (!/->\s*(passed|BUILD SUCCESSFUL)\b/i.test(line)) continue;
    const command = normalizeVerificationCommand(line);
    if (command) commands.add(command);
  }
  return commands;
}

function hasSuccessfulVerification(verificationLines: string[], pattern: RegExp): boolean {
  return verificationLines.some((line) => /->\s*passed\b/i.test(line) && pattern.test(line));
}

export function hasSuccessfulAuthoritativeBuild(verificationLines: string[]): boolean {
  return hasSuccessfulVerification(verificationLines, /\bxcodebuild\s+build\b/i) ||
    hasSuccessfulVerification(verificationLines, /\b(?:\.\/gradlew\s+)?(?:assembleDebug|test|check|build)\b/i) ||
    hasSuccessfulVerification(verificationLines, /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|test|typecheck)\b/i) ||
    hasSuccessfulVerification(verificationLines, /\b(?:swift|cargo|go)\s+(?:build|test)\b/i);
}

function isNetworkFetchCommand(command: string): boolean {
  return /\b(?:curl|wget)\b/i.test(command);
}

// Reduce a URL to host + path basename (query/flags stripped) so two fetches of
// the "same resource" match even when one adds --retry/--connect-timeout or
// hits a sibling path (…/openapi.json vs …/api/openapi.json).
function fetchUrlSignatures(command: string): string[] {
  const sigs: string[] = [];
  for (const match of command.matchAll(/https?:\/\/[^\s"'`)]+/gi)) {
    const url = match[0].replace(/[)"'`,;]+$/, "");
    try {
      const parsed = new URL(url);
      const base = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
      sigs.push(`${parsed.host.toLowerCase()}/${base.toLowerCase()}`);
    } catch {
      sigs.push(url.toLowerCase());
    }
  }
  return sigs;
}

function hasSuccessfulFetchOfSameResource(line: string, verificationLines: string[]): boolean {
  const failed = new Set(fetchUrlSignatures(normalizeVerificationCommand(line)));
  if (!failed.size) return false;
  return verificationLines.some((candidate) => {
    if (!/->\s*passed\b/i.test(candidate)) return false;
    const command = normalizeVerificationCommand(candidate);
    if (!isNetworkFetchCommand(command)) return false;
    return fetchUrlSignatures(command).some((sig) => failed.has(sig));
  });
}

function shellPathTokens(command: string): string[] {
  return command
    .split(/\s+/)
    .map((token) => token.replace(/^['"]|['"]$/g, "").replace(/[;,]$/g, ""))
    .filter((token) => /(?:^|\/)[\w.-]+\.[\w.-]+$/.test(token));
}

function hasSuccessfulCommandTouchingSamePath(line: string, verificationLines: string[], commandPattern: RegExp): boolean {
  const failedCommand = normalizeVerificationCommand(line);
  const failedPaths = shellPathTokens(failedCommand);
  if (!failedPaths.length) return false;
  return verificationLines.some((candidate) => {
    if (!/->\s*passed\b/i.test(candidate)) return false;
    const candidateCommand = normalizeVerificationCommand(candidate);
    if (!commandPattern.test(candidateCommand)) return false;
    const candidatePaths = shellPathTokens(candidateCommand);
    return failedPaths.some((failedPath) => candidatePaths.includes(failedPath));
  });
}

export function isRecoveredVerificationFailure(line: string, verificationLines: string[]): boolean {
  if (!/->\s*failed\b/i.test(line)) return false;
  if (/Shell (?:script|verification) rejected by safety checks/i.test(line)) return true;
  if (/Shell script rejected: git restore of historical content is not allowed/i.test(line)) return true;
  if (/bundle\s+install\b/i.test(line) &&
    /Host Ruby gem mutation is not allowed|host mutation safety checks/i.test(line) &&
    hasSuccessfulVerification(verificationLines, /\bfastlane\s+\w+\s+build\b/i)) {
    return true;
  }
  if (/\bktlintCheck\b/i.test(line) && hasSuccessfulVerification(verificationLines, /\bktlintCheck\b/i)) return true;
  if (/ktlintFormat\b/i.test(line) && hasSuccessfulVerification(verificationLines, /\bktlintCheck\b/i)) return true;
  if (/\.swiftlint\.yml\b/i.test(line) && hasSuccessfulVerification(verificationLines, /\bswiftlint\b/i)) return true;
  if (/\bcp\s+/i.test(line) && hasSuccessfulCommandTouchingSamePath(line, verificationLines, /\bcp\s+/i)) return true;
  if (/\bmkdir\s+-p\s+/i.test(line) && hasSuccessfulCommandTouchingSamePath(line, verificationLines, /\bmkdir\s+-p\s+/i)) return true;
  if (/\bfastlane\s+(\w+)\s+build\b/i.test(line)) {
    const laneMatch = line.match(/\bfastlane\s+(\w+)\s+build\b/i);
    const lane = laneMatch?.[1];
    if (lane && hasSuccessfulVerification(verificationLines, new RegExp(`\\bfastlane\\s+${lane}\\s+build\\b`, "i"))) {
      return true;
    }
  }
  if (/git\s+(?:-C\s+\S+\s+)?add\b/i.test(line) &&
    (hasSuccessfulVerification(verificationLines, /git\s+(?:-C\s+\S+\s+)?add\b/i) ||
      verificationLines.some((candidate) => /->\s*passed\b/i.test(candidate) && /git\s+(?:-C\s+\S+\s+)?add\b/i.test(candidate)))) {
    return true;
  }
  if (/git\s+(?:-C\s+\S+\s+)?add[\s\S]*git\s+(?:-C\s+\S+\s+)?commit/i.test(line) &&
    hasSuccessfulVerification(verificationLines, /git\s+(?:-C\s+\S+\s+)?add[\s\S]*git\s+(?:-C\s+\S+\s+)?commit/i)) {
    return true;
  }
  if (/xcodebuild[\s\S]*destination/i.test(line) &&
    hasSuccessfulVerification(verificationLines, /xcodebuild[\s\S]*destination/i)) {
    return true;
  }
  if (/assembleDebug\b/i.test(line) && hasSuccessfulVerification(verificationLines, /\bassembleDebug\b/i)) return true;
  if (/\b(?:grep|rg)\s+-c\b[\s\S]*(?:project\.pbxproj|build\.gradle\.kts|package\.json|tsconfig\.json|Info\.plist)/i.test(line) &&
    hasSuccessfulAuthoritativeBuild(verificationLines)) {
    return true;
  }
  const npmScriptMatch = line.match(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)\b/i);
  if (npmScriptMatch?.[1]) {
    const script = npmScriptMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (hasSuccessfulVerification(verificationLines, new RegExp(`\\b(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?${script}\\b`, "i"))) {
      return true;
    }
  }
  // A failed network fetch (curl/wget) is a transient probe failure — cold-start
  // backends (Azure App Service, etc.) and flaky CDNs intermittently return
  // 5xx / reset the connection (curl exit 56). Treat it as recovered when a
  // later verification line successfully fetched the SAME resource (same host +
  // path basename, so a retry with --retry/--connect-timeout or a sibling path
  // counts), OR when the run's authoritative build later passed — the build is
  // the real correctness gate, so a pre-build fetch blip is moot once the
  // artifact was obtained and the app compiled.
  if (isNetworkFetchCommand(line) &&
    (hasSuccessfulFetchOfSameResource(line, verificationLines) ||
      hasSuccessfulAuthoritativeBuild(verificationLines))) {
    return true;
  }
  // Generic: same shell command later succeeded (with optional exit-echo suffix).
  // Salvaged from F-fix.5+8 — handles the `cmd` -> failed / `cmd 2>&1; echo "EXIT=$?"` -> passed pattern.
  const failedCmd = line.replace(/^Verification:\s*/i, "").replace(/\s*->\s*failed\b[\s\S]*$/i, "").trim();
  if (failedCmd) {
    const escaped = failedCmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reSamePassed = new RegExp(`^(?:Verification:\\s*)?${escaped}(?:\\s+2>&1;?\\s*echo\\s+"EXIT=\\$\\?")?\\s*->\\s*passed\\b`, "i");
    if (verificationLines.some((other) => other !== line && reSamePassed.test(other))) {
      return true;
    }
  }
  return false;
}

function isSuccessfulAbsenceSearch(line: string, finalText: string): boolean {
  if (!/->\s*failed\b/i.test(line)) return false;
  const command = normalizeVerificationCommand(line);
  if (!/\b(?:grep|rg)\b/i.test(command)) return false;
  if (!/\b(?:no|none|without|absent|not found|not present|zero)\b/i.test(finalText)) return false;
  if (!/\b(?:references?|matches?|occurrences?|old|legacy|forbidden|stale)\b/i.test(finalText)) return false;
  return true;
}

export function failedVerificationBlockers(verificationLines: string[], finalText = ""): string[] {
  const successfulCommands = successfulVerificationCommands(finalText);
  return verificationLines
    .filter((line) => /->\s*failed\b/i.test(line))
    .filter((line) => !successfulCommands.has(normalizeVerificationCommand(line)))
    .filter((line) => !isSuccessfulAbsenceSearch(line, finalText))
    .filter((line) => !isRecoveredVerificationFailure(line, verificationLines))
    // A failed read-only probe (cat/ls/grep/test/which/--version) is never a
    // code-correctness gate — the exit code says nothing about whether the code
    // works. These were previously only dropped when an authoritative build
    // passed, so a failed `cat missing.go` on a run with no builtin verifier
    // survived as a gating blocker → false-FAIL.
    .filter((line) => !isRecoverableProbeCommand(localExecutableCommand(normalizeVerificationCommand(line))))
    .map((line) => `failed verification: ${line.replace(/^Verification:\s*/i, "")}`);
}
