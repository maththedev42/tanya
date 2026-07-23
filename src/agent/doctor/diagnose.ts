import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DEFAULT_FORBIDDEN_PATTERNS } from "../forbiddenPatterns";
import { FAILURE_CLASSES } from "./failureClasses";
import {
  appendLedgerEntry,
  checkEscalation,
  deriveSignature,
} from "./ledger";
import { writeImprovementDraft } from "./improvementDraft";
import type {
  RunArchive,
  DiagnosisEvidence,
  Diagnosis,
  DoctorOptions,
  ForbiddenPatternHit,
} from "./types";

// ---------------------------------------------------------------------------
// Archive discovery
// ---------------------------------------------------------------------------

/** Read a run archive from .tanya/runs/<runId>.json. Follows `.at` pointer
 *  files when the archive is stored elsewhere (serve-cwd runs archive at the
 *  serve workspace and leave a pointer in each touched repo). Returns the
 *  path the archive was actually read from so callers can derive the
 *  archive's own workspace. */
function resolveArchive(
  runsDir: string,
  runId: string,
): { archive: RunArchive; archivePath: string } | null {
  try {
    const directPath = join(runsDir, `${runId}.json`);
    if (existsSync(directPath)) {
      const archive = JSON.parse(readFileSync(directPath, "utf8")) as RunArchive;
      return { archive, archivePath: directPath };
    }
    const pointerPath = join(runsDir, `${runId}.at`);
    if (existsSync(pointerPath)) {
      const target = readFileSync(pointerPath, "utf8").trim();
      if (target && existsSync(target)) {
        const archive = JSON.parse(readFileSync(target, "utf8")) as RunArchive;
        return { archive, archivePath: target };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Find the most recent non-PASSED run archive in the runsDir, including
 *  archives reachable only through `.at` pointer files. Recency is file
 *  mtime, not runId lexicographic order. */
function findMostRecentFailed(
  runsDir: string,
): { runId: string; archive: RunArchive; archivePath: string } | null {
  try {
    if (!existsSync(runsDir)) return null;
    const entries = readdirSync(runsDir)
      .filter((f) => f.endsWith(".json") || f.endsWith(".at"))
      .flatMap((f) => {
        try {
          return [{ name: f, mtime: statSync(join(runsDir, f)).mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const entry of entries) {
      const runId = entry.name.replace(/\.(json|at)$/, "");
      const resolved = resolveArchive(runsDir, runId);
      if (resolved && resolved.archive.verdict !== "PASSED") {
        return { runId, ...resolved };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Check marker files in the cwd/repo's .tanya directory. */
function checkMarkers(tanyaDir: string): DiagnosisEvidence["markers"] {
  const lastRunFailed = existsSync(join(tanyaDir, "LAST_RUN_FAILED.md"));
  const runInProgressPath = join(tanyaDir, "RUN_IN_PROGRESS.md");
  const runInProgress = existsSync(runInProgressPath);
  let runInProgressPidAlive = false;
  if (runInProgress) {
    try {
      const content = readFileSync(runInProgressPath, "utf8");
      const match = content.match(/pid:\s*(\d+)/);
      if (match) {
        const pid = parseInt(match[1]!, 10);
        // Check if the pid is alive
        try {
          process.kill(pid, 0);
          runInProgressPidAlive = true;
        } catch {
          // pid is dead
        }
      }
    } catch {
      // Can't read, assume dead
    }
  }
  return { lastRunFailed, runInProgress, runInProgressPidAlive };
}

// ---------------------------------------------------------------------------
// Build errors from archive blockers
// ---------------------------------------------------------------------------

function extractBuildErrors(archive: RunArchive | null): string[] {
  if (!archive?.blockers) return [];
  const errors: string[] = [];
  for (const blocker of archive.blockers) {
    // Look for xcodebuild/gradle/tsc error lines within the blocker text
    const lines = blocker.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      // xcodebuild: starts with file:line:column: error: ...
      if (/^\S+\.swift:\d+:\d+: error:/.test(trimmed)) errors.push(trimmed);
      // gradle: e: file:///... or error: ...
      else if (/^e: /.test(trimmed) && trimmed.includes("error")) errors.push(trimmed);
      // tsc: .ts(line,col): error TS...
      else if (/\S+\.ts\(\d+,\d+\): error TS/.test(trimmed)) errors.push(trimmed);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Forbidden-pattern detection on current files
// ---------------------------------------------------------------------------

/** Scan the CURRENT content of the run's changed files against the real
 *  forbidden-pattern catalog — the same DEFAULT_FORBIDDEN_PATTERNS the run
 *  gates use, so doctor and the gates can never disagree on what a mangled
 *  edit looks like. Unlike scanForbiddenPatterns this never records fire
 *  metrics: doctor is read-only over the target repo.
 *
 *  changedFiles in an archive are relative to the archive's own workspace
 *  (serve-cwd runs archive at the serve root), so each file is resolved
 *  against the candidate base dirs in order. */
function detectForbiddenPatterns(changedFiles: string[], bases: string[]): ForbiddenPatternHit[] {
  const hits: ForbiddenPatternHit[] = [];
  for (const file of changedFiles) {
    const resolved = isAbsolute(file)
      ? (existsSync(file) ? file : null)
      : bases.map((base) => join(base, file)).find((p) => existsSync(p)) ?? null;
    if (!resolved) continue;
    const patterns = DEFAULT_FORBIDDEN_PATTERNS.filter(
      (p) => p.filePattern.test(file) && !(p.excludeFilePattern && p.excludeFilePattern.test(file)),
    );
    if (patterns.length === 0) continue;
    let content: string;
    try {
      content = readFileSync(resolved, "utf8");
    } catch {
      continue;
    }
    for (const pattern of patterns) {
      const probe = new RegExp(pattern.pattern.source, pattern.pattern.flags.replace("g", ""));
      if (!probe.test(content)) continue;
      if (pattern.suppressIfFileMatches && pattern.suppressIfFileMatches.test(content)) continue;
      const lines = content.split("\n");
      const lineIndex = lines.findIndex((line) => probe.test(line));
      hits.push({
        file,
        pattern: pattern.id,
        ...(lineIndex >= 0 ? { line: lineIndex + 1, match: lines[lineIndex]!.trim() } : {}),
        suggestion: pattern.message,
      });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------

export function collectEvidence(opts: DoctorOptions): {
  runId: string;
  evidence: DiagnosisEvidence;
} {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const tanyaDir = join(cwd, ".tanya");
  const runsDir = join(tanyaDir, "runs");

  let runId: string;
  let archive: RunArchive | null = null;
  let archivePath: string | null = null;

  if (opts.runId) {
    runId = opts.runId;
    const found = resolveArchive(runsDir, runId);
    if (found) {
      archive = found.archive;
      archivePath = found.archivePath;
    }
  } else {
    const found = findMostRecentFailed(runsDir);
    if (found) {
      runId = found.runId;
      archive = found.archive;
      archivePath = found.archivePath;
    } else {
      // No archive found — use marker-only diagnosis
      runId = "unknown";
    }
  }

  const markers = checkMarkers(tanyaDir);
  const buildErrors = extractBuildErrors(archive);
  // A pointer-followed archive lives at <its workspace>/.tanya/runs/<id>.json —
  // its changedFiles are relative to THAT workspace, not this cwd. Try both.
  const archiveWorkspace = archivePath ? resolve(archivePath, "..", "..", "..") : null;
  const bases = archiveWorkspace && archiveWorkspace !== cwd ? [cwd, archiveWorkspace] : [cwd];
  const forbiddenPatternHits = archive?.changedFiles
    ? detectForbiddenPatterns(archive.changedFiles, bases)
    : [];

  return {
    runId,
    evidence: {
      archive,
      markers,
      buildErrors,
      forbiddenPatternHits,
    },
  };
}

export function classifyEvidence(evidence: DiagnosisEvidence): string[] {
  const matched: string[] = [];
  for (const fc of FAILURE_CLASSES) {
    if (fc.detect(evidence)) {
      matched.push(fc.id);
    }
  }
  if (matched.length === 0) return ["unknown"];
  return matched;
}

export function buildDiagnosis(
  runId: string,
  evidence: DiagnosisEvidence,
  classes: string[],
): Diagnosis {
  const classEntries = FAILURE_CLASSES.filter((fc) => classes.includes(fc.id));

  // Build explanation from all matching classes
  const explanationParts: string[] = [];
  explanationParts.push(`# Diagnosis — ${runId}`);
  explanationParts.push("");
  explanationParts.push(`## Verdict`);

  if (evidence.archive) {
    if (evidence.archive.aborted) {
      explanationParts.push("The run **aborted** before finalizing.");
      if (evidence.archive.terminationReason) {
        explanationParts.push(`Termination: ${evidence.archive.terminationReason}`);
      }
    } else {
      explanationParts.push(
        `The run completed with verdict **${evidence.archive.verdict ?? "unknown"}**.`,
      );
    }
  } else {
    explanationParts.push("No run archive found — diagnosis based on markers only.");
  }

  if (classes.includes("unknown")) {
    explanationParts.push("");
    explanationParts.push("## Unknown Failure Class");
    explanationParts.push("");
    explanationParts.push(
      "This failure does not match any known classification. Below is the strongest evidence.",
    );
    if (evidence.archive?.blockers?.length) {
      explanationParts.push("");
      explanationParts.push("### Blockers:");
      for (const b of evidence.archive.blockers) explanationParts.push(`- ${b}`);
    }
    if (evidence.archive?.gateLog?.length) {
      explanationParts.push("");
      explanationParts.push("### Gate log:");
      for (const g of evidence.archive.gateLog.slice(-10)) explanationParts.push(`- ${g}`);
    }
  }

  explanationParts.push("");
  explanationParts.push("## Classification");
  explanationParts.push("");
  if (classes.includes("unknown")) {
    explanationParts.push("- `unknown` — this failure is not yet catalogued");
  } else {
    for (const id of classes) explanationParts.push(`- \`${id}\``);
  }

  // Add per-class explanations
  for (const fc of classEntries) {
    explanationParts.push("");
    explanationParts.push(fc.explain(evidence));
  }

  const explanation = explanationParts.join("\n");

  // Build repair prompt
  const promptParts: string[] = [];
  promptParts.push(`# Repair prompt — ${runId}`);
  promptParts.push("");

  for (const fc of classEntries) {
    promptParts.push(fc.prescribe(evidence));
    promptParts.push("");
  }

  if (classes.includes("unknown")) {
    promptParts.push("## Unknown — manual repair needed");
    promptParts.push("");
    promptParts.push("This failure is unclassified. Review the evidence above and");
    promptParts.push("diagnose manually.");
  }

  const repairPrompt = promptParts.join("\n");

  return {
    runId,
    classes,
    explanation,
    repairPrompt,
  };
}

export function writeDiagnosisOutput(
  cwd: string,
  diagnosis: Diagnosis,
): { diagPath: string; repairPath: string } {
  const doctorDir = join(cwd, ".tanya", "doctor");
  mkdirSync(doctorDir, { recursive: true });

  const diagPath = join(doctorDir, `${diagnosis.runId}.md`);
  writeFileSync(diagPath, diagnosis.explanation, "utf8");

  const repairPath = join(doctorDir, `${diagnosis.runId}-repair-prompt.md`);
  writeFileSync(repairPath, diagnosis.repairPrompt, "utf8");

  return { diagPath, repairPath };
}

export function runDoctor(opts: DoctorOptions = {}): Diagnosis {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const { runId, evidence } = collectEvidence({ ...opts, cwd });

  // A healthy repo is not a diagnosis: no archive and no failure markers means
  // there is nothing to doctor — return without writing artifacts.
  const deadMarker = evidence.markers.lastRunFailed
    || (evidence.markers.runInProgress && !evidence.markers.runInProgressPidAlive);
  if (!evidence.archive && !deadMarker) {
    return {
      runId,
      classes: [],
      explanation: "No failed run found — no FAIL/aborted archive under .tanya/runs and no failure markers. Nothing to diagnose.",
      repairPrompt: "",
    };
  }

  const classes = classifyEvidence(evidence);
  let diagnosis = buildDiagnosis(runId, evidence, classes);

  // ---- Recurrence ledger ----
  // Append a ledger entry for each class (one signature per run).
  const signature = deriveSignature(classes, evidence);
  for (const classId of new Set(classes)) {
    appendLedgerEntry(cwd, {
      ts: new Date().toISOString(),
      runId,
      classId,
      signature,
    });
  }

  // Check for escalation (new unknown class, or known-class nag)
  const escalation = checkEscalation(cwd, runId, classes, evidence);

  if (escalation) {
    // Write the improvement draft
    const draftPath = writeImprovementDraft(cwd, escalation, evidence);

    // Add nag lines to the diagnosis explanation
    const nagParts: string[] = [];
    nagParts.push("");
    nagParts.push("---");
    nagParts.push("");

    if (escalation.newUnknownClass) {
      nagParts.push("## ⚠ Escalation: new unknown failure class recurring");
      nagParts.push("");
      nagParts.push(
        `This \`unknown\`-class failure has appeared ${escalation.entries.length + 1} times.`,
      );
      nagParts.push("An improvement draft has been generated — review and dispatch manually.");
    } else {
      nagParts.push("## ⚠ Recurring known class");
      nagParts.push("");
      nagParts.push(
        `The class \`${classes.filter(c => c !== "unknown").join("`, `")}\` keeps firing — the defense may need strengthening.`,
      );
      nagParts.push("An improvement draft has been generated — review and dispatch manually.");
    }
    nagParts.push("");
    nagParts.push(`Improvement draft: \`.tanya/doctor/${draftPath.split("/").pop()}\``);
    nagParts.push("");

    diagnosis = {
      ...diagnosis,
      explanation: diagnosis.explanation + nagParts.join("\n"),
    };
  }

  writeDiagnosisOutput(cwd, diagnosis);

  return diagnosis;
}

// ---------------------------------------------------------------------------
// Hook: append Doctor line to final report on FAIL verdict
// ---------------------------------------------------------------------------

/** Appended to the final run report when the verdict is FAIL. Called from
 *  ensureCodingReport — the single report-building seam shared by the native
 *  runner and the external-backend path — so every FAIL run gets the pointer
 *  regardless of entrypoint. */
export function doctorReportFooter(runId: string): string {
  return `Doctor: run \`tanya doctor --run ${runId}\` for a diagnosis and a ready repair prompt.`;
}
