import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ToolResult } from "./types";

// The single choke point every write-capable tool call passes through before
// it executes (wired in ToolRegistry.run). Today it holds NO policy — every
// call is allowed — it exists so write-hold rules (protected-path globs and
// friends) land here as a pure drop-in instead of scattering checks across
// call sites. Contract for future rules, in CodeWhale's terms: authority can
// only tighten (there is no "allow" shape that widens access), and failures
// degrade toward zero holds — a broken rules file must weaken the gate,
// never poison legitimate writes.

/** Tools that can create or modify workspace files via a path-shaped input.
 *  Shell/command tools mutate too but are governed by their own safety
 *  checks; the gate covers the direct file-writing surface. */
export const WRITE_CAPABLE_TOOLS = new Set([
  "write_file",
  "apply_patch",
  "search_replace",
  "edit_block",
  "copy_file",
  "copy_dir",
  "apply_artifact",
]);

/** Lexically normalize a write target to a workspace-relative path, collapsing
 *  `.`/`..` segments so path spelling cannot evade a future rule glob.
 *  Targets that resolve outside the workspace are kept (prefixed `../`) —
 *  over-collection is the point; the workspace-escape check itself lives in
 *  resolveInsideWorkspace at execution time. */
export function normalizeWriteTarget(workspace: string, target: string): string {
  const absolute = isAbsolute(target) ? target : resolve(workspace, target);
  return relative(workspace, absolute) || ".";
}

/** Extract target paths from unified-diff headers. Over-collects: takes the
 *  `+++` side of every hunk, falling back to the `---` side for deletions
 *  (`+++ /dev/null`), and strips one leading `a/`/`b/` component. */
export function collectPatchTargets(patch: string): string[] {
  const targets: string[] = [];
  const lines = patch.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line.startsWith("+++ ")) continue;
    let raw = line.slice(4).trim();
    if (raw === "/dev/null") {
      const minus = lines[i - 1] ?? "";
      raw = minus.startsWith("--- ") ? minus.slice(4).trim() : "";
    }
    if (!raw || raw === "/dev/null") continue;
    raw = raw.split("\t")[0] ?? raw;
    const stripped = raw.replace(/^[ab]\//, "");
    if (stripped) targets.push(stripped);
  }
  return [...new Set(targets)];
}

/** Over-collect the paths a write-capable tool call intends to touch, from
 *  every param shape the write tools use. Unknown shapes yield [] — the gate
 *  never guesses. */
export function collectWriteTargets(toolName: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const str = (key: string): string[] =>
    typeof record[key] === "string" && (record[key] as string).trim() ? [(record[key] as string).trim()] : [];
  switch (toolName) {
    case "write_file":
    case "search_replace":
    case "edit_block":
      return str("path");
    case "copy_file":
    case "copy_dir":
      return str("destination");
    case "apply_artifact":
      return str("targetPath");
    case "apply_patch":
      return typeof record.patch === "string" ? collectPatchTargets(record.patch) : [];
    default:
      return [];
  }
}

// ── Protected-path write holds (.tanya/protect.json) ────────────────────────
//
// Repo law: a workspace can declare paths no run may write, with WHY. The
// schema has no allow shape — a protect file can only tighten. Every failure
// (missing file, parse error, malformed rule) degrades toward FEWER holds,
// never a poisoned gate. `ask` fails closed to block: the tool gate has no
// interactive channel, so even bypass/full-access modes cannot skip a hold.
//
//   { "protected": [
//       { "text": "provider-picker WIP is another session's front",
//         "paths": ["apps/macos/Tanya/Chat/ProviderKeyConfigSheet.swift"],
//         "action": "block" } ] }
//
// Globs: `*` = within a segment, `?` = one char, `**` = across segments.
// Protecting a subtree needs `dir/**` (an exact path matches only itself).

export interface ProtectRule {
  text: string;
  paths: string[];
  action: "block" | "ask";
  matchers: RegExp[];
}

export function compileGlob(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        // `**/` spans zero or more whole segments; bare/trailing `**` spans anything.
        if (glob[i + 2] === "/") {
          pattern += "(?:[^/]+/)*";
          i += 2;
        } else {
          pattern += ".*";
          i += 1;
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}

function parseProtectRules(raw: string): ProtectRule[] {
  const parsed = JSON.parse(raw) as { protected?: unknown };
  if (!parsed || !Array.isArray(parsed.protected)) return [];
  const rules: ProtectRule[] = [];
  for (const entry of parsed.protected) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const paths = Array.isArray(record.paths)
      ? record.paths.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim())
      : [];
    if (paths.length === 0) continue;
    rules.push({
      text: typeof record.text === "string" && record.text.trim() ? record.text.trim() : "protected path",
      paths,
      // Any action other than "ask" is the stricter "block"; both stop the
      // write here — the law only tightens.
      action: record.action === "ask" ? "ask" : "block",
      matchers: paths.map(compileGlob),
    });
  }
  return rules;
}

const protectRuleCache = new Map<string, { mtimeMs: number; size: number; rules: ProtectRule[] }>();

export function loadProtectRules(workspace: string): ProtectRule[] {
  const path = join(workspace, ".tanya", "protect.json");
  try {
    const stat = statSync(path);
    const cached = protectRuleCache.get(workspace);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.rules;
    const rules = parseProtectRules(readFileSync(path, "utf8"));
    protectRuleCache.set(workspace, { mtimeMs: stat.mtimeMs, size: stat.size, rules });
    return rules;
  } catch {
    // No protect file / unreadable / invalid JSON → zero holds.
    protectRuleCache.delete(workspace);
    return [];
  }
}

// Per-run hold breadcrumbs, drained into manifest.gateLog at report time.
const HOLD_LOG_MAX_RUNS = 32;
const HOLD_LOG_MAX_ENTRIES = 50;
const holdLog = new Map<string, string[]>();

function recordHold(runId: string | undefined, entry: string): void {
  if (!runId) return;
  const entries = holdLog.get(runId) ?? [];
  if (entries.length < HOLD_LOG_MAX_ENTRIES) entries.push(entry);
  holdLog.set(runId, entries);
  if (holdLog.size > HOLD_LOG_MAX_RUNS) {
    const oldest = holdLog.keys().next().value;
    if (oldest !== undefined) holdLog.delete(oldest);
  }
}

/** Read-and-clear the protect-hold breadcrumbs for a run. */
export function drainProtectHoldLog(runId: string): string[] {
  const entries = holdLog.get(runId) ?? [];
  holdLog.delete(runId);
  return entries;
}

function buildHoldRefusal(toolName: string, target: string, rule: ProtectRule): ToolResult {
  const detail = [
    `protected path: ${target} — ${rule.text} (rule in .tanya/protect.json${rule.action === "ask" ? ", action \"ask\" fails closed here" : ""}).`,
    "This hold cannot be bypassed by any permission mode. Work on a different path, or report the conflict and let the user lift the protection.",
  ].join("\n");
  return {
    ok: false,
    summary: `Write blocked: ${target} is protected — ${rule.text}`,
    error: detail,
    output: { ok: false, blockedPath: target, invariant: rule.text, tool: toolName },
  };
}

export type ToolGateDecision =
  | { allowed: true; targets: string[] }
  | { allowed: false; targets: string[]; refusal: ToolResult };

/** Evaluate the gate for one tool call: collect the write targets and hold
 *  any that hit a protected-path rule. Non-write tools and rule-less
 *  workspaces always pass. */
export function evaluateToolGate(params: {
  toolName: string;
  input: unknown;
  workspace: string;
  runId?: string;
}): ToolGateDecision {
  if (!WRITE_CAPABLE_TOOLS.has(params.toolName)) return { allowed: true, targets: [] };
  const targets = collectWriteTargets(params.toolName, params.input)
    .map((target) => normalizeWriteTarget(params.workspace, target));
  const rules = loadProtectRules(params.workspace);
  if (rules.length > 0) {
    for (const target of targets) {
      const hit = rules.find((rule) => rule.matchers.some((matcher) => matcher.test(target)));
      if (hit) {
        recordHold(params.runId, `protect-hold: BLOCK ${params.toolName} ${target} (${hit.text})`);
        return { allowed: false, targets, refusal: buildHoldRefusal(params.toolName, target, hit) };
      }
    }
  }
  return { allowed: true, targets };
}
