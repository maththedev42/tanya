import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CoverageItem, SpecRequirement } from "./specCoverage";

// Repeat-offense tracking (gate-escape E7). Items 6/7 of the hosting spec were
// requested and silently dropped across four prompts in three days. A single
// run's coverage table can't see that history; this persists each run's coverage
// to `.tanya/spec-coverage-history.json` and flags an item that was left
// unfinished (pending/skipped) in a recent prior run, so the highest-signal
// deliverables — the ones a run keeps dropping — are called out, not buried.
//
// Synchronous on purpose: it is called from ensureCodingReport, which is sync.
// Best-effort throughout — a read/write failure never breaks a run.

const HISTORY_FILE = ".tanya/spec-coverage-history.json";
const MAX_RUNS = 12;

type HistoryRun = { items: { id: string; status: string }[] };
type History = { runs: HistoryRun[] };

/** Normalize an id so `TANYA-06`, `tanya 6`, `TANYA-6` collapse to one key. */
function normId(id: string): string {
  return id.toLowerCase().replace(/[\s_]+/g, "-").replace(/-0*(\d)/g, "-$1").trim();
}

function readHistory(workspace: string): History {
  try {
    const raw = readFileSync(join(workspace, HISTORY_FILE), "utf8");
    const parsed = JSON.parse(raw) as History;
    if (parsed && Array.isArray(parsed.runs)) return parsed;
  } catch {
    // no history yet / unreadable — start fresh
  }
  return { runs: [] };
}

/** Mark items that were unfinished (pending/skipped) in a recent prior run. */
export function markRepeatOffenders(
  workspace: string,
  _requirements: SpecRequirement[],
  coverage: CoverageItem[],
): CoverageItem[] {
  const history = readHistory(workspace);
  if (history.runs.length === 0) return coverage;
  // An id is a prior offender if any recent run left it pending/skipped.
  const priorOffenders = new Set<string>();
  for (const run of history.runs) {
    for (const item of run.items) {
      if (item.status === "pending" || item.status === "skipped") priorOffenders.add(normId(item.id));
    }
  }
  return coverage.map((item) => {
    const unfinishedNow = item.status === "pending" || item.status === "skipped";
    return unfinishedNow && priorOffenders.has(normId(item.id))
      ? { ...item, repeatOffense: true }
      : item;
  });
}

/** Append this run's coverage to the rolling history (best-effort). */
export function recordCoverageHistory(workspace: string, coverage: CoverageItem[]): void {
  if (coverage.length === 0) return;
  try {
    const history = readHistory(workspace);
    history.runs.push({ items: coverage.map((c) => ({ id: c.id, status: c.status })) });
    if (history.runs.length > MAX_RUNS) history.runs = history.runs.slice(-MAX_RUNS);
    const path = join(workspace, HISTORY_FILE);
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(history, null, 2));
  } catch {
    // best-effort — never break a run over history bookkeeping
  }
}
