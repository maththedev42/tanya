import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DiagnosisEvidence } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LedgerEntry = {
  ts: string; // ISO timestamp
  runId: string;
  classId: string;
  signature: string;
};

export type EscalationResult = {
  /** The signature that triggered escalation. */
  signature: string;
  /** Matched entries from the ledger. */
  entries: LedgerEntry[];
  /** Whether this is a new unknown-class recurrence (needs improvement draft). */
  newUnknownClass: boolean;
  /** Whether this is a known-class recurrence ≥3 in 7 days. */
  knownClassNag: boolean;
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function doctorDir(cwd: string): string {
  return join(cwd, ".tanya", "doctor");
}

function ledgerPath(cwd: string): string {
  return join(doctorDir(cwd), "ledger.jsonl");
}

// ---------------------------------------------------------------------------
// Signature normalization
// ---------------------------------------------------------------------------

const PATH_RE = /(?:\/)?(?:[\w.-]+\/)*[\w.-]+\.[a-z]{1,6}/g;
const NUMBER_RE = /\b\d+\b/g;
const RUNID_RE = /\br-[a-z0-9]+-[a-z0-9]+\b/g;
const TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;

/** Normalize a blocker line into a stable signature: strip paths, numbers,
 *  runIds, and timestamps so the same failure on different files/lines
 *  collides on the signature. */
export function normalizeSignature(line: string): string {
  return line
    .replace(PATH_RE, "<path>")
    .replace(RUNID_RE, "<runId>")
    .replace(TS_RE, "<ts>")
    .replace(NUMBER_RE, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Derive a signature from evidence. Uses the first blocker line when
 *  available, otherwise falls back to the class id alone. */
export function deriveSignature(
  classes: string[],
  evidence: DiagnosisEvidence,
): string {
  // Prefer first blocker line
  const firstBlocker = evidence.archive?.blockers?.[0];
  if (firstBlocker) {
    return normalizeSignature(firstBlocker);
  }
  // Fall back to joined class IDs
  return classes.join(",");
}

// ---------------------------------------------------------------------------
// Ledger I/O
// ---------------------------------------------------------------------------

/** Append a ledger entry. Creates the ledger file and directory if needed. */
export function appendLedgerEntry(
  cwd: string,
  entry: LedgerEntry,
): void {
  mkdirSync(doctorDir(cwd), { recursive: true });
  const line = JSON.stringify(entry) + "\n";
  appendFileSync(ledgerPath(cwd), line, "utf8");
}

/** Read all valid ledger entries. Malformed lines are skipped. */
export function readLedger(cwd: string): LedgerEntry[] {
  const path = ledgerPath(cwd);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const entries: LedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as LedgerEntry;
      if (parsed.ts && parsed.runId && parsed.classId && parsed.signature) {
        entries.push(parsed);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Check if the current diagnosis triggers an escalation (new unknown class
 *  recurrence or known-class nag). Returns null if no escalation. */
export function checkEscalation(
  cwd: string,
  runId: string,
  classes: string[],
  evidence: DiagnosisEvidence,
): EscalationResult | null {
  const ledger = readLedger(cwd);
  const signature = deriveSignature(classes, evidence);

  // Filter entries with the SAME signature (exclude the current run)
  const sameSig = ledger.filter((e) => e.signature === signature && e.runId !== runId);

  if (sameSig.length === 0) return null;

  const now = Date.now();
  const within7d = sameSig.filter((e) => {
    const ets = new Date(e.ts).getTime();
    return now - ets <= SEVEN_DAYS_MS;
  });

  // Escalation rule 1: unknown class x ≥2 (total, not just within window)
  const newUnknownClass = classes.includes("unknown") && sameSig.length >= 1;

  // Escalation rule 2: known class x ≥3 within 7 days
  const knownClassNag =
    !classes.includes("unknown") && within7d.length >= 2; // 2 prior + current = 3

  if (!newUnknownClass && !knownClassNag) return null;

  return {
    signature,
    entries: sameSig,
    newUnknownClass,
    knownClassNag,
  };
}

// ---------------------------------------------------------------------------
// Summary (for --list)
// ---------------------------------------------------------------------------

/** Generate a human-readable ledger summary string. */
export function ledgerSummary(cwd: string): string {
  const ledger = readLedger(cwd);

  if (ledger.length === 0) {
    return "## Doctor Ledger\n\nNo entries yet.";
  }

  // Group by classId
  const classCounts: Record<string, number> = {};
  for (const entry of ledger) {
    classCounts[entry.classId] = (classCounts[entry.classId] ?? 0) + 1;
  }

  // Recent unique signatures (last 20 entries, deduped by signature)
  const seenSigs = new Set<string>();
  const recentSigs: LedgerEntry[] = [];
  for (const entry of ledger.reverse()) {
    if (!seenSigs.has(entry.signature)) {
      seenSigs.add(entry.signature);
      recentSigs.push(entry);
    }
    if (recentSigs.length >= 20) break;
  }
  ledger.reverse(); // restore original order (via reverse of reversed)

  const lines: string[] = [];
  lines.push("## Doctor Ledger");
  lines.push("");
  lines.push(`Total entries: ${ledger.length}`);
  lines.push("");
  lines.push("### Class counts");
  for (const [classId, count] of Object.entries(classCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${classId}\`: ${count}`);
  }
  lines.push("");
  lines.push("### Recent signatures");
  for (const entry of ledger.slice(-10).reverse()) {
    lines.push(`- ${entry.ts.slice(0, 10)} — ${entry.runId} — \`${entry.classId}\``);
    lines.push(`  ${entry.signature.slice(0, 100)}`);
  }

  // Check for improvement drafts
  const doctorDirPath = doctorDir(cwd);
  let improvementFiles: string[] = [];
  if (existsSync(doctorDirPath)) {
    improvementFiles = readdirSync(doctorDirPath).filter(
      (f: string) => f.startsWith("improvement-") && f.endsWith(".md"),
    );
  }
  if (improvementFiles.length > 0) {
    lines.push("");
    lines.push("### Pending improvement drafts");
    for (const f of improvementFiles) {
      lines.push(`- ${f}`);
    }
  }

  return lines.join("\n");
}
