import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Verify-gate: a task's `## Verify` / `## Acceptance` section lists commands
// that MUST run with passing evidence before the run can claim success. The
// audited failure wrote a migration and skipped the section's required
// `cosmohq restart` + `psql \d` checks, breaking the API for hours. This turns
// those listed commands into a hard requirement: any one without a passing
// verification line blocks the SUCCESS verdict.
//
// Plus a per-repo boot-smoke hook: when a run edits infra files (e.g.
// migrations), a configured `command` (+ health check) is auto-added to the
// required set — defense-in-depth for the exact "migration broke boot" shape.

// Backtick spans are only treated as commands when they lead with a known tool
// (or `./`), so prose and code snippets (`L10n.tr("…")`) are never required.
const COMMAND_LEADERS = new Set([
  "npm", "npx", "pnpm", "yarn", "node", "tsx", "deno", "vitest", "jest", "eslint", "tsc",
  "go", "cargo", "rustc", "make", "cmake", "gradle", "./gradlew", "mvn", "bazel",
  "python", "python3", "pip", "pip3", "pytest", "ruby", "bundle", "rake",
  "xcodebuild", "swift", "pod", "fastlane", "flutter", "dart", "dotnet",
  "docker", "docker-compose", "kubectl", "helm", "terraform",
  "psql", "mysql", "sqlite3", "redis-cli", "goose", "migrate", "prisma", "alembic", "sqlc",
  "curl", "wget", "http", "bash", "sh", "zsh", "git", "tanya", "cosmohq",
]);

export type BootSmokeCheck = { trigger: string; command: string; healthCheck?: string };

function firstToken(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

function looksLikeCommand(span: string): boolean {
  const s = span.trim();
  if (!s || s.length > 200) return false;
  // Reject code-shaped spans (calls, generics, member access with args).
  if (/[(){}]|=>|::|<\/?[a-z]/i.test(s)) return false;
  const first = firstToken(s);
  return first.startsWith("./") || COMMAND_LEADERS.has(first);
}

/** Commands the prompt's `## Verify` / `## Acceptance` section requires. */
export function parseVerifyCommands(prompt: string): string[] {
  const lines = prompt.split(/\r?\n/);
  const commands: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const title = (heading[2] ?? "").toLowerCase();
      inSection = /^(?:verify|verification|acceptance|acceptance criteria|how to verify|proof)\b/.test(title.replace(/[*_`]/g, "").trim());
      continue;
    }
    if (!inSection) continue;
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const span = (match[1] ?? "").trim();
      if (looksLikeCommand(span)) commands.push(span);
    }
  }
  return [...new Set(commands)];
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] ?? "";
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?"; // `**/` -> zero-or-more path segments
          i += 2;
        } else {
          re += ".*"; // `**` -> anything
          i += 1;
        }
      } else {
        re += "[^/]*"; // `*` -> within a segment
      }
    } else if (/[.*+?^${}()|[\]\\]/.test(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`(?:^|/)${re}$`);
}

/** Load `.tanya/boot-smoke.json` (fail-soft to []). */
export async function loadBootSmokeConfig(workspace: string): Promise<BootSmokeCheck[]> {
  try {
    const raw = await readFile(join(workspace, ".tanya", "boot-smoke.json"), "utf8");
    const parsed = JSON.parse(raw) as { checks?: unknown };
    const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
    return checks
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .map((c) => {
        const check: BootSmokeCheck = {
          trigger: typeof c.trigger === "string" ? c.trigger : "",
          command: typeof c.command === "string" ? c.command : "",
        };
        if (typeof c.healthCheck === "string") check.healthCheck = c.healthCheck;
        return check;
      })
      .filter((c) => c.trigger && c.command);
  } catch {
    return [];
  }
}

/** Boot-smoke commands whose trigger glob matches a changed file. */
export function bootSmokeCommands(checks: BootSmokeCheck[], changedFiles: string[]): string[] {
  const out: string[] = [];
  for (const check of checks) {
    const re = globToRegExp(check.trigger);
    if (changedFiles.some((f) => re.test(f))) out.push(check.command);
  }
  return [...new Set(out)];
}

const PASS_MARKER = /(?:->\s*passed|\bpassed\b|success marker found|shell exited 0|build succeeded|exited 0\b|status 200|200 ok)/i;

/** The passing verification line that evidences a required command ran, or null.
 *  A passing line must mention the command's first token AND (for multi-token
 *  commands) a second distinctive token — generous enough not to false-flag a
 *  command that ran, strict enough to catch one that never did. */
export function verificationEvidence(command: string, verificationLines: string[]): string | null {
  const tokens = command.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 1 && !t.startsWith("-"));
  const lead = tokens[0];
  if (!lead) return null;
  const second = tokens.find((t, i) => i > 0 && t.length >= 3);
  return verificationLines.find((line) => {
    const ll = line.toLowerCase();
    if (/->\s*failed\b/.test(ll)) return false;
    if (!PASS_MARKER.test(ll)) return false;
    if (!ll.includes(lead)) return false;
    return second ? ll.includes(second) : true;
  }) ?? null;
}

/** Did a required command run with passing evidence in the verification log? */
export function commandVerified(command: string, verificationLines: string[]): boolean {
  return verificationEvidence(command, verificationLines) !== null;
}

export type VerifyCommandVerdict = { cmd: string; verified: boolean; evidence?: string };

/** Every required verify command (prompt + boot-smoke) with its pass/fail and
 *  the evidencing line, for the run archive's gate section. */
export async function evaluateVerifyCommands(
  prompt: string,
  changedFiles: string[],
  verificationLines: string[],
  workspace: string,
): Promise<VerifyCommandVerdict[]> {
  const required = [
    ...parseVerifyCommands(prompt),
    ...bootSmokeCommands(await loadBootSmokeConfig(workspace), changedFiles),
  ];
  return [...new Set(required)].map((cmd) => {
    const evidence = verificationEvidence(cmd, verificationLines);
    return { cmd, verified: evidence !== null, ...(evidence ? { evidence: evidence.trim().slice(0, 200) } : {}) };
  });
}

/** The required verify commands (prompt + boot-smoke) that have NO passing
 *  evidence in the verification log. */
export async function unexecutedVerifyCommands(
  prompt: string,
  changedFiles: string[],
  verificationLines: string[],
  workspace: string,
): Promise<string[]> {
  const verdicts = await evaluateVerifyCommands(prompt, changedFiles, verificationLines, workspace);
  return verdicts.filter((verdict) => !verdict.verified).map((verdict) => verdict.cmd);
}
