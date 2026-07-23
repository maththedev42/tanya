import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The run-step ledger (P2-B core, CodeWhale fleet.jsonl design): an
// append-only `.tanya/ledger.jsonl` in the workspace recording, AS THEY
// HAPPEN, the steps that are expensive to re-derive after a crash or FAIL —
// commits (sha + files) and verification outcomes. The archive only lands at
// finalize; the ledger survives kill -9 mid-run. Recovery runs receive a
// LEDGER DIGEST built from it ("committed already: ..., verified green: ...")
// instead of re-auditing the tree — the end of the re-audit burn loop.
//
// Crash-safety contract (ported): one JSON record per line; before appending,
// a missing trailing newline is repaired first, so a crashed writer's partial
// line becomes its own malformed line — replay skips it with a count, earlier
// state never corrupts. All writes are best-effort and never fail a run.
// Lease/CAS-fenced resume orchestration is deliberately NOT here yet — it
// lands with the serve queue-hold work it depends on.

export type LedgerRecord =
  | { type: "run_start"; runId: string; ts: string; prompt: string }
  | { type: "commit"; runId: string; ts: string; sha: string; files: string[]; message: string }
  | { type: "verification"; runId: string; ts: string; command: string; result: "passed" | "failed" }
  | { type: "run_end"; runId: string; ts: string; verdict: "PASSED" | "FAIL"; blockers: string[]; changedFiles: string[] };

const LEDGER_REL = join(".tanya", "ledger.jsonl");
const LEDGER_MAX_BYTES = 1024 * 1024;
const LEDGER_KEEP_LINES = 400;

export function ledgerPath(workspace: string): string {
  return join(workspace, LEDGER_REL);
}

/** Append one record. Torn-tail quarantine: if the file's last byte is not a
 *  newline (a previous writer died mid-line), write the newline FIRST so the
 *  partial line is isolated as its own malformed line. Never throws. */
export function appendLedgerRecord(workspace: string, record: LedgerRecord): void {
  try {
    const path = ledgerPath(workspace);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const stat = statSync(path);
      if (stat.size > 0) {
        const tail = Buffer.alloc(1);
        const fd = openSync(path, "r");
        try {
          readSync(fd, tail, 0, 1, stat.size - 1);
        } finally {
          closeSync(fd);
        }
        if (tail.toString("utf8") !== "\n") appendFileSync(path, "\n", "utf8");
      }
      if (stat.size > LEDGER_MAX_BYTES) rotateLedger(path);
    }
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // The ledger must never fail a run.
  }
}

function rotateLedger(path: string): void {
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    writeFileSync(path, `${lines.slice(-LEDGER_KEEP_LINES).join("\n")}\n`, "utf8");
  } catch {
    // Rotation is best-effort.
  }
}

/** Replay the ledger. Malformed lines (torn tails, corruption) are skipped
 *  and counted, never fatal. */
export function readLedger(workspace: string): { records: LedgerRecord[]; skippedLines: number } {
  try {
    const raw = readFileSync(ledgerPath(workspace), "utf8");
    const records: LedgerRecord[] = [];
    let skippedLines = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as LedgerRecord;
        if (parsed && typeof parsed === "object" && typeof parsed.type === "string" && typeof parsed.runId === "string") {
          records.push(parsed);
        } else {
          skippedLines += 1;
        }
      } catch {
        skippedLines += 1;
      }
    }
    return { records, skippedLines };
  } catch {
    return { records: [], skippedLines: 0 };
  }
}

/** The digest a recovery run receives instead of re-deriving progress from
 *  the tree. Null when the ledger holds nothing useful for the run. */
export function ledgerDigestForRun(workspace: string, runId: string): string | null {
  const { records } = readLedger(workspace);
  const forRun = records.filter((record) => record.runId === runId);
  if (forRun.length === 0) return null;
  const commits = forRun.filter((record): record is Extract<LedgerRecord, { type: "commit" }> => record.type === "commit");
  const verifications = forRun.filter(
    (record): record is Extract<LedgerRecord, { type: "verification" }> => record.type === "verification",
  );
  // Last outcome per command wins (a later green supersedes an earlier red).
  const verdictByCommand = new Map<string, "passed" | "failed">();
  for (const record of verifications) verdictByCommand.set(record.command, record.result);
  const green = [...verdictByCommand.entries()].filter(([, result]) => result === "passed").map(([command]) => command);
  const red = [...verdictByCommand.entries()].filter(([, result]) => result === "failed").map(([command]) => command);
  if (commits.length === 0 && green.length === 0 && red.length === 0) return null;
  const lines: string[] = ["## LEDGER DIGEST (recorded live by the failed run — trust it, do not re-derive)"];
  if (commits.length > 0) {
    lines.push("Already COMMITTED (do not redo or re-audit these):");
    for (const commit of commits) {
      const files = commit.files.slice(0, 12).join(", ") + (commit.files.length > 12 ? `, +${commit.files.length - 12} more` : "");
      lines.push(`- ${commit.sha} ${commit.message}${files ? ` [${files}]` : ""}`);
    }
  }
  if (green.length > 0) {
    lines.push("Verified GREEN before the run ended (do not re-run unless you change related code):");
    for (const command of green.slice(0, 10)) lines.push(`- ${command}`);
  }
  if (red.length > 0) {
    lines.push("Still RED when the run ended (the actual remaining work):");
    for (const command of red.slice(0, 10)) lines.push(`- ${command}`);
  }
  return lines.join("\n");
}
