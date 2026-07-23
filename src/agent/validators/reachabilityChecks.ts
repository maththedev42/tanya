import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findWorkspaceFiles, readWorkspaceFile, type ValidationIssue, type Validator } from "./core";

const execFileAsync = promisify(execFile);

// Nudge-tier (WARNING) reachability + external-fact checks. Unlike the ERROR
// static checks these encode HEURISTICS, so they never hard-fail a working app —
// they surface a "look at this" so the agent (or human) can confirm the code is
// actually reachable / the external fact is real. Each target a shape that
// shipped looking-implemented-but-dead or plausible-but-wrong:
//   - a UI action that is a no-op (activateFileViewerSelecting([]));
//   - an enum case / export nothing else references (declared, never emitted);
//   - a hardcoded external exit-code / stderr string that was never verified.

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SOURCE = /\.(?:swift|kt|kts|java|go|ts|tsx|js|jsx|py|rb|rs|m|mm)$/i;

// ---------------------------------------------------------------------------
// No-op UI handler: a system API called with empty/constant args so it does
// nothing (the shipped `NSWorkspace.shared.activateFileViewerSelecting([])`).
// ---------------------------------------------------------------------------
const NO_OP_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /activateFileViewerSelecting\(\s*\[\s*\]\s*\)/, what: "activateFileViewerSelecting([]) reveals nothing" },
  { re: /activateFileViewerSelecting\(\s*\[\s*URL\s*\]\s*\(\s*\)\s*\)/, what: "activateFileViewerSelecting with an empty URL array" },
  { re: /\.open\(\s*\[\s*\]\s*(?:,|\))/, what: "NSWorkspace.open([]) opens nothing" },
];

export const noOpHandlerValidator: Validator = {
  id: "task.noOpHandler",
  async run(workspace, manifest) {
    const files = manifest.changedFiles.filter((f) => SOURCE.test(f));
    const issues: ValidationIssue[] = [];
    for (const file of files) {
      const content = await readWorkspaceFile(workspace, file);
      if (!content) continue;
      for (const { re, what } of NO_OP_PATTERNS) {
        if (re.test(content)) {
          issues.push({
            id: "task-no-op-handler",
            severity: "warning",
            message: `${file} calls a system API with empty/constant arguments (${what}) — it compiles but does nothing at runtime. Pass the real value or remove the dead action.`,
            files: [file],
          });
        }
      }
    }
    return issues;
  },
};

// ---------------------------------------------------------------------------
// Dead enum case: an enum case declared but referenced nowhere else — the
// "declared but never emitted/handled" shape.
// ---------------------------------------------------------------------------
function extractEnumCases(content: string): string[] {
  if (!/\benum\b/.test(content)) return [];
  const cases = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    // Enum DECLARATION cases only: `case foo`, `case foo, bar`, `case foo(Int)`
    // — never a switch arm (which ends in `:` or dots into a member).
    const m = line.match(/^\s*case\s+([a-zA-Z_]\w*(?:\s*,\s*[a-zA-Z_]\w*)*)\s*(?:\([^)]*\))?\s*$/);
    if (!m || m[1] === undefined) continue;
    for (const name of m[1].split(/\s*,\s*/)) if (name) cases.add(name);
  }
  return [...cases];
}

export const deadEnumCaseValidator: Validator = {
  id: "task.deadEnumCase",
  async run(workspace, manifest) {
    const files = manifest.changedFiles.filter((f) => /\.(?:swift|kt|kts)$/i.test(f));
    if (files.length === 0) return [];
    const issues: ValidationIssue[] = [];
    let treeCache: Map<string, string> | null = null;
    const loadTree = async () => {
      if (treeCache) return treeCache;
      const map = new Map<string, string>();
      const paths = await findWorkspaceFiles(workspace, (p) => /\.(?:swift|kt|kts)$/i.test(p), { limit: 400 });
      for (const p of paths) map.set(p, (await readWorkspaceFile(workspace, p)) ?? "");
      treeCache = map;
      return map;
    };
    for (const file of files) {
      const content = await readWorkspaceFile(workspace, file);
      if (!content) continue;
      const cases = extractEnumCases(content);
      if (cases.length === 0) continue;
      const tree = await loadTree();
      for (const enumCase of cases) {
        const refRe = new RegExp(`\\b${escapeRe(enumCase)}\\b`, "g");
        let refs = 0;
        for (const [path, text] of tree) {
          const count = (text.match(refRe) ?? []).length;
          // Discount the single declaration occurrence in the defining file.
          refs += path === file ? Math.max(0, count - 1) : count;
        }
        if (refs === 0) {
          issues.push({
            id: "task-enum-case-unreferenced",
            severity: "warning",
            message: `Enum case \`${enumCase}\` in ${file} is never referenced anywhere else — likely declared but never emitted or handled. Wire it into the code path that should produce it, or remove it.`,
            files: [file],
          });
        }
      }
    }
    return issues;
  },
};

// ---------------------------------------------------------------------------
// Dead Go export: an exported symbol in a NEWLY-ADDED .go file with no
// reference outside its own file and _test.go.
// ---------------------------------------------------------------------------
async function newlyAddedFiles(workspace: string, candidates: string[]): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=1", "--"], {
      cwd: workspace,
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const added = new Set<string>();
    for (const line of stdout.split(/\r?\n/)) {
      // "A " staged-add, "??" untracked → newly added this session.
      if (/^(?:A[ MD]|\?\?)\s/.test(line)) {
        const p = line.slice(3).trim();
        if (p) added.add(p);
      }
    }
    return new Set(candidates.filter((c) => added.has(c)));
  } catch {
    return new Set();
  }
}

function extractGoExports(content: string): string[] {
  const names = new Set<string>();
  for (const m of content.matchAll(/^\s*(?:func|type|var|const)\s+([A-Z]\w*)/gm)) if (m[1]) names.add(m[1]);
  for (const m of content.matchAll(/^\s*func\s+\([^)]*\)\s+([A-Z]\w*)/gm)) if (m[1]) names.add(m[1]);
  return [...names];
}

export const deadGoExportValidator: Validator = {
  id: "task.deadGoExport",
  async run(workspace, manifest) {
    const goFiles = manifest.changedFiles.filter((f) => /\.go$/.test(f) && !/_test\.go$/.test(f));
    if (goFiles.length === 0) return [];
    const added = await newlyAddedFiles(workspace, goFiles);
    if (added.size === 0) return [];
    const tree = await findWorkspaceFiles(workspace, (p) => /\.go$/.test(p), { limit: 600 });
    const contents = new Map<string, string>();
    for (const p of tree) contents.set(p, (await readWorkspaceFile(workspace, p)) ?? "");
    const issues: ValidationIssue[] = [];
    for (const file of added) {
      const content = contents.get(file) ?? (await readWorkspaceFile(workspace, file)) ?? "";
      const testFile = file.replace(/\.go$/, "_test.go");
      for (const symbol of extractGoExports(content)) {
        const refRe = new RegExp(`\\b${escapeRe(symbol)}\\b`, "g");
        let external = 0;
        for (const [path, text] of contents) {
          if (path === file || path === testFile) continue;
          external += (text.match(refRe) ?? []).length;
        }
        if (external === 0) {
          issues.push({
            id: "task-go-export-unreferenced",
            severity: "warning",
            message: `Exported Go symbol \`${symbol}\` in the new file ${file} is referenced nowhere outside its own file — it looks like dead code that was written but never wired in. Call it from the dispatch/handler it was meant for, or remove it.`,
            files: [file],
          });
        }
      }
    }
    return issues;
  },
};

// ---------------------------------------------------------------------------
// External-fact: branching on an external tool's exact exit code / stderr with
// no in-session verification and no ASSUMPTION marker (the invented `146`).
// ---------------------------------------------------------------------------
const EXIT_CODE = /\b(?:exit\s*code|exitcode|returncode|waitstatus)\b[^\n=]{0,20}(?:===?|==|-eq)\s*(\d{1,3})\b/gi;
const SHELL_EXIT = /\$\?\s*-eq\s*(\d{1,3})\b/g;
const STDERR_MATCH = /\bstderr\b[^\n]{0,40}?(?:includes|contains|indexOf|match|==|===)\s*[^\n]{0,20}?(["'`][^"'`\n]{3,}["'`])/gi;

export const externalFactValidator: Validator = {
  id: "task.externalFactAssumption",
  async run(workspace, manifest) {
    const files = manifest.changedFiles.filter((f) => SOURCE.test(f));
    const issues: ValidationIssue[] = [];
    for (const file of files) {
      const content = await readWorkspaceFile(workspace, file);
      if (!content) continue;
      // Respect an explicit in-code ASSUMPTION marker (defensive-and-documented).
      if (/\bASSUMPTION\b/.test(content)) continue;
      const hits = new Set<string>();
      for (const m of content.matchAll(EXIT_CODE)) if (m[1] && Number(m[1]) !== 0) hits.add(m[0].trim());
      for (const m of content.matchAll(SHELL_EXIT)) if (m[1] && Number(m[1]) !== 0) hits.add(m[0].trim());
      for (const m of content.matchAll(STDERR_MATCH)) if (m[1]) hits.add(`stderr match ${m[1]}`);
      if (hits.size === 0) continue;
      issues.push({
        id: "task-external-fact-unverified",
        severity: "warning",
        message: `${file} branches on an external tool's exact behaviour (${[...hits].slice(0, 3).join("; ")}) with no in-session verification and no ASSUMPTION note. Run the tool and cite the observed output, OR match the broadest safe condition and add an \`ASSUMPTION:\` line to your report so it is reviewable.`,
        files: [file],
      });
    }
    return issues;
  },
};

// ---------------------------------------------------------------------------
// Empty conditional stub: `if (…) { // comment }` — a branch whose body is only
// a comment, standing in for work that was specced but never written (the
// analytics event that shipped as `if … { // track here }`).
// ---------------------------------------------------------------------------
// Match `if <cond> {` (Swift/Kotlin/Go/TS) or `if (<cond>):`/`if <cond>:` then a
// body that is only comment/blank lines up to the closing brace.
const EMPTY_IF_BRACED = /\bif\b[^\n{;]*\{\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)+\}/g;

export const emptyConditionalStubValidator: Validator = {
  id: "task.emptyConditionalStub",
  async run(workspace, manifest) {
    const files = manifest.changedFiles.filter((f) => SOURCE.test(f));
    const issues: ValidationIssue[] = [];
    for (const file of files) {
      const content = await readWorkspaceFile(workspace, file);
      if (!content) continue;
      if (EMPTY_IF_BRACED.test(content)) {
        issues.push({
          id: "task-empty-conditional-stub",
          severity: "warning",
          message: `${file} has a conditional whose body is only a comment — it compiles but does nothing when the branch is taken. If this stands in for specced work (an analytics event, a side effect), implement the body; if the branch is genuinely a no-op, remove it.`,
          files: [file],
        });
      }
      EMPTY_IF_BRACED.lastIndex = 0;
    }
    return issues;
  },
};

// ---------------------------------------------------------------------------
// Constant-default field: a struct/model field declared with a literal default
// that no call site ever sets — so a filter/branch on it is dead (the shipped
// `isAvailable = true` default that made the availability filter a no-op).
// ---------------------------------------------------------------------------
// Swift/Kotlin field decls with a bool literal default: `let/var name = true`,
// `val name: Boolean = false`, `var name = true`.
const BOOL_FIELD_DECL = /^\s*(?:public\s+|private\s+|internal\s+|open\s+|final\s+)*(?:let|var|val)\s+([a-zA-Z_]\w*)\s*(?::\s*(?:Bool|Boolean)\s*)?=\s*(true|false)\b/gm;

export const constantFieldValidator: Validator = {
  id: "task.constantDefaultField",
  async run(workspace, manifest) {
    const files = manifest.changedFiles.filter((f) => /\.(?:swift|kt|kts)$/i.test(f));
    if (files.length === 0) return [];
    const issues: ValidationIssue[] = [];
    let treeCache: Map<string, string> | null = null;
    const loadTree = async () => {
      if (treeCache) return treeCache;
      const map = new Map<string, string>();
      const paths = await findWorkspaceFiles(workspace, (p) => /\.(?:swift|kt|kts)$/i.test(p), { limit: 400 });
      for (const p of paths) map.set(p, (await readWorkspaceFile(workspace, p)) ?? "");
      treeCache = map;
      return map;
    };
    for (const file of files) {
      const content = await readWorkspaceFile(workspace, file);
      if (!content) continue;
      const fields = new Map<string, string>(); // name -> default literal
      for (const m of content.matchAll(BOOL_FIELD_DECL)) if (m[1] && m[2]) fields.set(m[1], m[2]);
      if (fields.size === 0) continue;
      const tree = await loadTree();
      for (const [field, def] of fields) {
        const f = escapeRe(field);
        // Is the field ever ASSIGNED a non-default value at a call site — a member
        // assignment `.field = …` (not `==`), or a constructor label `field: <var>`
        // whose value is a lowercase identifier (a real value, NOT a type like
        // `: Bool` and NOT the literal default)? The declaration itself never counts.
        const assignRe = new RegExp(`\\.${f}\\s*=\\s*(?!=)|\\b${f}\\s*:\\s*(?![A-Z])(?!${def}\\b)[a-z_]`, "g");
        // Must also be READ in a branch/filter context to be worth flagging.
        const branchRe = new RegExp(`(?:\\bif\\b[^\\n{]*|\\bguard\\b[^\\n{]*|\\bwhere\\b[^\\n]*|\\.filter\\b[^\\n]*)\\b${f}\\b`, "g");
        let assigned = 0;
        let branched = 0;
        for (const [, text] of tree) {
          assigned += (text.match(assignRe) ?? []).length;
          branched += (text.match(branchRe) ?? []).length;
        }
        if (assigned === 0 && branched > 0) {
          issues.push({
            id: "task-constant-default-field",
            severity: "warning",
            message: `Field \`${field}\` in ${file} defaults to \`${def}\` and is never assigned any other value anywhere, yet a filter/branch depends on it — the condition is constant, so that logic is dead. Populate the field from real data, or drop the branch.`,
            files: [file],
          });
        }
      }
    }
    return issues;
  },
};

// ---------------------------------------------------------------------------
// Deleted analytics: a `track`/analytics/logEvent emit present before a rewrite
// and absent after — an event silently dropped in a refactor.
// ---------------------------------------------------------------------------
const TRACK_CALL = /\b(?:Observability\.track|analytics(?:Manager)?\.(?:track|logEvent|log)|\.logEvent|\btrack|\blogEvent|\bcapture)\s*\(\s*(["'`][^"'`\n)]{2,}["'`]|[A-Za-z_][\w.]*)/;

function extractTrackEvents(line: string): string[] {
  const out: string[] = [];
  const m = line.match(TRACK_CALL);
  if (m && m[1]) out.push(m[1].replace(/^["'`]|["'`]$/g, ""));
  return out;
}

export const deletedAnalyticsValidator: Validator = {
  id: "task.deletedAnalytics",
  async run(workspace, manifest) {
    const files = manifest.changedFiles.filter((f) => SOURCE.test(f));
    if (files.length === 0) return [];
    // Diff each changed file since the run's baseline (catches committed AND
    // uncommitted removals). Fall back to HEAD when no baseline is recorded.
    const base = manifest.sessionBaseHead ?? "HEAD";
    const issues: ValidationIssue[] = [];
    for (const file of files) {
      let diff: string;
      try {
        const { stdout } = await execFileAsync("git", ["diff", "-U0", base, "--", file], {
          cwd: workspace,
          timeout: 5_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        diff = stdout;
      } catch {
        continue;
      }
      if (!diff) continue;
      const removed = new Set<string>();
      const added = new Set<string>();
      for (const line of diff.split(/\r?\n/)) {
        if (/^-(?![-])/.test(line)) for (const ev of extractTrackEvents(line.slice(1))) removed.add(ev);
        else if (/^\+(?![+])/.test(line)) for (const ev of extractTrackEvents(line.slice(1))) added.add(ev);
      }
      const dropped = [...removed].filter((ev) => !added.has(ev));
      if (dropped.length > 0) {
        issues.push({
          id: "task-analytics-event-deleted",
          severity: "warning",
          message: `${file} removed analytics emit(s) that the pre-image had and the new version doesn't re-add: ${dropped.slice(0, 4).join(", ")}. If the event was renamed that's fine; if it was dropped in a rewrite, restore it — deleted tracking is silent data loss.`,
          files: [file],
        });
      }
    }
    return issues;
  },
};

export const reachabilityValidators: Validator[] = [
  noOpHandlerValidator,
  deadEnumCaseValidator,
  deadGoExportValidator,
  externalFactValidator,
  emptyConditionalStubValidator,
  constantFieldValidator,
  deletedAnalyticsValidator,
];
