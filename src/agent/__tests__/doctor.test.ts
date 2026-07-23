import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  collectEvidence,
  classifyEvidence,
  buildDiagnosis,
  runDoctor,
  doctorReportFooter,
} from "../doctor/diagnose";
import type { DiagnosisEvidence, RunArchive } from "../doctor/types";
import { FAILURE_CLASSES } from "../doctor/failureClasses";
import {
  normalizeSignature,
  appendLedgerEntry,
  readLedger,
  checkEscalation,
  deriveSignature,
  ledgerSummary,
} from "../doctor/ledger";
import { ensureCodingReport } from "../report";
import type { TanyaFinalManifest } from "../runner";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function fixtureArchive(overrides: Partial<RunArchive> = {}): RunArchive {
  return {
    runId: "r-fixture-001",
    verdict: "FAIL",
    changedFiles: ["src/foo.swift"],
    uncommittedFiles: ["src/foo.swift"],
    greenBuildObserved: false,
    blockers: [],
    ...overrides,
  };
}

function fixtureEvidence(overrides: Partial<DiagnosisEvidence> = {}): DiagnosisEvidence {
  return {
    archive: fixtureArchive(),
    markers: { lastRunFailed: false, runInProgress: false, runInProgressPidAlive: false },
    buildErrors: [],
    forbiddenPatternHits: [],
    ...overrides,
  };
}

let tmpDirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync("/tmp/tanya-doctor-test-");
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function writeRunsDir(cwd: string, runId: string, archive: RunArchive): void {
  const runsDir = join(cwd, ".tanya", "runs");
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, `${runId}.json`), JSON.stringify(archive), "utf8");
}

function writeAtPointer(cwd: string, runId: string, targetPath: string): void {
  const runsDir = join(cwd, ".tanya", "runs");
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, `${runId}.at`), targetPath, "utf8");
}

function writeMarker(cwd: string, name: string, content = ""): void {
  const tanyaDir = join(cwd, ".tanya");
  mkdirSync(tanyaDir, { recursive: true });
  writeFileSync(join(tanyaDir, name), content, "utf8");
}

// ---------------------------------------------------------------------------
// Each classifier detects its own fixture and NOT the others
// ---------------------------------------------------------------------------

describe("failureClasses — detect per class", () => {
  for (const fc of FAILURE_CLASSES) {
    describe(fc.id, () => {
      it("detects its own fixture", () => {
        const evidence = fixtureEvidence();

        // Prime the evidence so detect() returns true for this class.
        switch (fc.id) {
          case "dead-run-dirty-tree":
            evidence.archive = fixtureArchive({ aborted: true });
            break;
          case "stall-blind-build":
            evidence.archive = fixtureArchive({
              terminationReason: "turn_budget_exhausted",
              blockers: ["Build verification failed: error: use of unresolved identifier 'Foo'"],
            });
            break;
          case "commit-incomplete":
            evidence.archive = fixtureArchive({
              blockers: ["Commit incomplete: files this run wrote are still uncommitted"],
            });
            break;
          case "verification-stale":
            evidence.archive = fixtureArchive({
              blockers: ["Verification stale — build ran before last edit"],
            });
            break;
          case "spec-gap":
            evidence.archive = fixtureArchive({
              gates: {
                specCoverage: { armed: true, passed: false, reason: "3/5 covered", covered: 3, total: 5 },
              },
            });
            break;
          case "subagent-child-failed":
            evidence.archive = fixtureArchive({
              childVerdicts: [{ label: "worker-1", verdict: "FAIL", blockers: ["build broke"] }],
            });
            break;
          case "unsupported-deferral":
            evidence.archive = fixtureArchive({
              verdict: "FAIL",
              blockers: ["Deferred deliverable skipped without prompt citation"],
            });
            break;
          case "mangled-edit":
            // mangled-edit depends on current file content for forbidden patterns,
            // so we test it differently below.
            evidence.forbiddenPatternHits = [
              {
                file: "src/foo.swift",
                line: 10,
                pattern: "swift-escaped-string-interpolation",
                match: "\\(",
                suggestion: "Use \\( instead",
              },
            ];
            break;
        }

        expect(fc.detect(evidence)).toBe(true);
      });

      it("does NOT fire on an empty / unrelated fixture", () => {
        const evidence = fixtureEvidence();

        // For each pair, turn OFF the signals of the target class and make sure
        // detect returns false.
        switch (fc.id) {
          case "dead-run-dirty-tree":
            evidence.archive!.aborted = false;
            break;
          case "stall-blind-build":
            delete evidence.archive!.terminationReason;
            evidence.archive!.blockers = [];
            break;
          case "commit-incomplete":
            evidence.archive!.blockers = [];
            break;
          case "verification-stale":
            evidence.archive!.blockers = [];
            break;
          case "spec-gap":
            evidence.archive!.blockers = [];
            delete evidence.archive!.gates;
            break;
          case "subagent-child-failed":
            evidence.archive!.childVerdicts = [];
            break;
          case "unsupported-deferral":
            evidence.archive!.verdict = "PASSED";
            evidence.archive!.blockers = [];
            break;
          case "mangled-edit":
            evidence.forbiddenPatternHits = [];
            break;
        }

        expect(fc.detect(evidence)).toBe(false);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Unknown class fires on an unmatched fixture
// ---------------------------------------------------------------------------

describe("unknown classification", () => {
  it("returns ['unknown'] when no class matches", () => {
    // A PASS run with zero blockers and no interesting markers.
    const evidence = fixtureEvidence({
      archive: fixtureArchive({ verdict: "PASSED", blockers: [], aborted: false }),
    });
    const classes = classifyEvidence(evidence);
    expect(classes).toEqual(["unknown"]);
  });
});

// ---------------------------------------------------------------------------
// Repair prompt contains evidence lines and a Verify section
// ---------------------------------------------------------------------------

describe("buildDiagnosis and repair prompt", () => {
  it("includes evidence in explanation and repair prompt", () => {
    const archive = fixtureArchive({
      blockers: ["Commit incomplete: files this run wrote are still uncommitted — src/foo.swift"],
      changedFiles: ["src/foo.swift", "src/bar.swift"],
    });
    const evidence: DiagnosisEvidence = {
      archive,
      markers: { lastRunFailed: false, runInProgress: false, runInProgressPidAlive: false },
      buildErrors: [],
      forbiddenPatternHits: [],
    };
    const classes = classifyEvidence(evidence);
    expect(classes).toContain("commit-incomplete");

    const diagnosis = buildDiagnosis("r-test", evidence, classes);

    // Explanation quotes evidence
    expect(diagnosis.explanation).toContain("Commit Incomplete");
    expect(diagnosis.explanation).toContain("src/foo.swift");

    // Repair prompt has a Verify section
    expect(diagnosis.repairPrompt).toContain("## Verify");
    expect(diagnosis.repairPrompt).toContain("git status");
  });

  it("repair prompt for dead-run includes original prompt when available", () => {
    const archive = fixtureArchive({
      aborted: true,
      prompt: "Build the app",
      changedFiles: ["src/app.ts"],
    });
    const evidence: DiagnosisEvidence = {
      archive,
      markers: { lastRunFailed: false, runInProgress: false, runInProgressPidAlive: false },
      buildErrors: [],
      forbiddenPatternHits: [],
    };
    const classes = classifyEvidence(evidence);
    expect(classes).toContain("dead-run-dirty-tree");

    const diagnosis = buildDiagnosis("r-test", evidence, classes);
    expect(diagnosis.repairPrompt).toContain("Build the app");
  });
});

// ---------------------------------------------------------------------------
// Marker detection: LAST_RUN_FAILED, RUN_IN_PROGRESS with dead pid
// ---------------------------------------------------------------------------

describe("marker detection", () => {
  it("detects LAST_RUN_FAILED marker", () => {
    const cwd = tmpDir();
    writeMarker(cwd, "LAST_RUN_FAILED.md", "Run left uncommitted files");

    const evidence = fixtureEvidence({ archive: null });
    const fc = FAILURE_CLASSES.find((c) => c.id === "dead-run-dirty-tree")!;

    // Manual check: markers should be detected
    const { evidence: collected } = collectEvidence({ cwd });
    expect(collected.markers.lastRunFailed).toBe(true);
    expect(fc.detect(collected)).toBe(true);
  });

  it("detects stale RUN_IN_PROGRESS with dead pid", () => {
    const cwd = tmpDir();
    const deadPid = 99999; // Extremely unlikely to be alive
    writeMarker(cwd, "RUN_IN_PROGRESS.md", `pid: ${deadPid}\nstarted: 2026-01-01`);

    const { evidence } = collectEvidence({ cwd });
    expect(evidence.markers.runInProgress).toBe(true);
    expect(evidence.markers.runInProgressPidAlive).toBe(false);

    const fc = FAILURE_CLASSES.find((c) => c.id === "dead-run-dirty-tree")!;
    expect(fc.detect(evidence)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Archive discovery from .tanya/runs/
// ---------------------------------------------------------------------------

describe("archive discovery", () => {
  it("finds the most recent FAIL archive", () => {
    const cwd = tmpDir();
    writeRunsDir(cwd, "r-old-pass", {
      runId: "r-old-pass",
      verdict: "PASSED",
      blockers: [],
    });
    writeRunsDir(cwd, "r-recent-fail", {
      runId: "r-recent-fail",
      verdict: "FAIL",
      blockers: ["something broke"],
      changedFiles: ["src/x.ts"],
    });

    const { runId, evidence } = collectEvidence({ cwd });
    expect(runId).toBe("r-recent-fail");
    expect(evidence.archive?.verdict).toBe("FAIL");
  });

  it("follows .at pointer files", () => {
    const cwd = tmpDir();
    const realPath = join(cwd, "some-other-dir", "real-archive.json");
    mkdirSync(join(cwd, "some-other-dir"), { recursive: true });
    writeFileSync(realPath, JSON.stringify({
      runId: "r-pointer",
      verdict: "FAIL",
      blockers: ["pointer test"],
    }));

    writeAtPointer(cwd, "r-pointer", realPath);

    // Direct read via readArchive-like path via collectEvidence
    // collectEvidence with an explicit runId follows pointers
    const { runId, evidence } = collectEvidence({ cwd, runId: "r-pointer" });
    expect(runId).toBe("r-pointer");
    expect(evidence.archive?.verdict).toBe("FAIL");
    expect(evidence.archive?.blockers).toContain("pointer test");
  });
});

// ---------------------------------------------------------------------------
// Forbidden-pattern detection from current file content
// ---------------------------------------------------------------------------

describe("forbidden-pattern detection", () => {
  it("detects a REAL mangled edit (double-escaped interpolation) via the shared catalog", () => {
    const cwd = tmpDir();
    const badFile = join(cwd, "bad.swift");
    // On-disk content: let x = "hello \\(name)" — the doubled backslash is the
    // agent/JSON over-escape the catalog's swift-escaped-string-interpolation
    // pattern exists for.
    writeFileSync(badFile, 'let x = "hello \\\\(name)"\n', "utf8");

    writeRunsDir(cwd, "r-fp", fixtureArchive({ changedFiles: [badFile] }));
    const result = collectEvidence({ cwd, runId: "r-fp" });
    expect(result.evidence.forbiddenPatternHits.length).toBeGreaterThan(0);
    expect(result.evidence.forbiddenPatternHits[0]!.pattern).toBe("swift-escaped-string-interpolation");
    expect(result.evidence.forbiddenPatternHits[0]!.line).toBe(1);

    const fc = FAILURE_CLASSES.find((c) => c.id === "mangled-edit")!;
    expect(fc.detect(result.evidence)).toBe(true);
  });

  it("does NOT flag correct Swift interpolation (single backslash)", () => {
    const cwd = tmpDir();
    const goodFile = join(cwd, "good.swift");
    // On-disk content: let x = "hello \(name)" — correct Swift, must not fire.
    writeFileSync(goodFile, 'let x = "hello \\(name)"\n', "utf8");

    writeRunsDir(cwd, "r-fp-good", fixtureArchive({ changedFiles: [goodFile] }));
    const result = collectEvidence({ cwd, runId: "r-fp-good" });
    expect(result.evidence.forbiddenPatternHits).toEqual([]);
  });

  it("resolves workspace-relative changedFiles against the pointer archive's workspace", () => {
    const cwd = tmpDir();
    const ws = tmpDir();
    const wsRuns = join(ws, ".tanya", "runs");
    mkdirSync(wsRuns, { recursive: true });
    mkdirSync(join(ws, "proj", "src"), { recursive: true });
    writeFileSync(join(ws, "proj", "src", "y.swift"), 'Text("total \\\\(sum)")\n', "utf8");
    writeFileSync(join(wsRuns, "r-remote.json"), JSON.stringify({
      runId: "r-remote",
      verdict: "FAIL",
      blockers: ["remote fail"],
      changedFiles: ["proj/src/y.swift"],
    }));
    writeAtPointer(cwd, "r-remote", join(wsRuns, "r-remote.json"));

    // No --run: discovery must follow the .at pointer, and the scan must find
    // the file relative to the archive's OWN workspace, not this cwd.
    const { runId, evidence } = collectEvidence({ cwd });
    expect(runId).toBe("r-remote");
    expect(evidence.archive?.blockers).toContain("remote fail");
    expect(evidence.forbiddenPatternHits.length).toBeGreaterThan(0);
    expect(evidence.forbiddenPatternHits[0]!.pattern).toBe("swift-escaped-string-interpolation");
  });
});

// ---------------------------------------------------------------------------
// Healthy repo: nothing to diagnose, nothing written
// ---------------------------------------------------------------------------

describe("healthy repo", () => {
  it("returns no classes and writes no artifacts when there is nothing to diagnose", () => {
    const cwd = tmpDir();
    writeRunsDir(cwd, "r-ok", { runId: "r-ok", verdict: "PASSED", blockers: [] });

    const diagnosis = runDoctor({ cwd });
    expect(diagnosis.classes).toEqual([]);
    expect(diagnosis.explanation).toContain("Nothing to diagnose");
    expect(existsSync(join(cwd, ".tanya", "doctor"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FAIL-finalize hook appends Doctor line
// ---------------------------------------------------------------------------

describe("doctorReportFooter", () => {
  it("returns a line pointing at tanya doctor command", () => {
    const footer = doctorReportFooter("r-test-123");
    expect(footer).toContain("tanya doctor --run r-test-123");
    expect(footer).toContain("diagnosis");
    expect(footer).toContain("repair prompt");
  });
});

// The footer is wired at the ensureCodingReport seam — shared by the native
// runner and the external-backend path — so every entrypoint's FAIL report
// carries it. These tests drive the real seam, not just the string helper.
describe("doctor line at the report seam", () => {
  function seamManifest(overrides: Partial<TanyaFinalManifest> = {}): TanyaFinalManifest {
    return {
      schemaVersion: 1,
      changedFiles: ["a.ts"],
      uncommittedFiles: [],
      artifactsRead: [],
      artifactsCreated: [],
      contextFilesRead: [],
      verification: [],
      git: { root: "/repo", head: "abc1234" },
      toolErrors: 0,
      blockers: [],
      runId: "r-seam-1",
      ...overrides,
    } as TanyaFinalManifest;
  }

  it("appends the Doctor line to FAIL reports, before the result line", () => {
    const out = ensureCodingReport("Did some work.", seamManifest({ blockers: ["build broke"] }));
    expect(out).toContain("tanya doctor --run r-seam-1");
    const lines = out.trim().split("\n");
    expect(lines[lines.length - 1]).toBe("TANYA RESULT: FAIL");
  });

  it("does not double-append when the report already carries the line", () => {
    const m = seamManifest({ blockers: ["build broke"] });
    const once = ensureCodingReport("Did some work.", m);
    const twice = ensureCodingReport(once, m);
    expect(twice.match(/tanya doctor --run/g)?.length).toBe(1);
  });

  it("stays off PASSED reports", () => {
    const out = ensureCodingReport("Did some work.", seamManifest());
    expect(out).not.toContain("tanya doctor");
    expect(out.trim().split("\n").at(-1)).toBe("TANYA RESULT: PASSED");
  });

  it("stays off FAIL manifests without a runId", () => {
    const { runId: _omit, ...rest } = seamManifest({ blockers: ["x"] });
    const out = ensureCodingReport("Did some work.", rest as TanyaFinalManifest);
    expect(out).not.toContain("tanya doctor");
  });
});

// ---------------------------------------------------------------------------
// Integration: runDoctor writes output files
// ---------------------------------------------------------------------------

describe("runDoctor integration", () => {
  it("writes diagnosis and repair prompt to .tanya/doctor/", () => {
    const cwd = tmpDir();
    writeRunsDir(cwd, "r-integration", {
      runId: "r-integration",
      verdict: "FAIL",
      blockers: ["Commit incomplete: files uncommitted"],
      changedFiles: ["src/a.ts"],
    });

    const diagnosis = runDoctor({ cwd, runId: "r-integration" });

    const diagPath = join(cwd, ".tanya", "doctor", "r-integration.md");
    const repairPath = join(cwd, ".tanya", "doctor", "r-integration-repair-prompt.md");

    expect(existsSync(diagPath)).toBe(true);
    expect(existsSync(repairPath)).toBe(true);

    const diagContent = readFileSync(diagPath, "utf8");
    expect(diagContent).toContain("r-integration");
    expect(diagContent).toContain("Commit Incomplete");

    const repairContent = readFileSync(repairPath, "utf8");
    expect(repairContent).toContain("## Verify");
    expect(repairContent).toContain("src/a.ts");
  });
});

// ---------------------------------------------------------------------------
// Signature normalization
// ---------------------------------------------------------------------------

describe("normalizeSignature", () => {
  it("strips paths, numbers, runIds, and timestamps", () => {
    const sig = normalizeSignature(
      "Commit incomplete: files uncommitted — /Users/x/tanya/src/agent/runner.ts line 42 and r-abc123-def456 at 2026-07-20T12:00:00Z",
    );
    expect(sig).not.toContain("/Users");
    expect(sig).not.toContain("/tanya");
    expect(sig).not.toContain("42");
    expect(sig).not.toContain("abc123");
    expect(sig).not.toContain("2026-07-20");
    expect(sig).toContain("commit incomplete");
    expect(sig).toContain("<path>");
    expect(sig).toContain("<n>");
    expect(sig).toContain("<runid>");
    expect(sig).toContain("<ts>");
  });

  it("same failure on different files/lines yields same signature", () => {
    const sig1 = normalizeSignature(
      "Build error: src/foo.swift:10: error: use of unresolved identifier 'Bar'",
    );
    const sig2 = normalizeSignature(
      "Build error: src/baz.swift:99: error: use of unresolved identifier 'Bar'",
    );
    expect(sig1).toBe(sig2);
  });

  it("different failure messages yield different signatures", () => {
    const sig1 = normalizeSignature("Commit incomplete");
    const sig2 = normalizeSignature("Build error");
    expect(sig1).not.toBe(sig2);
  });
});

// ---------------------------------------------------------------------------
// Ledger I/O: append, read, malformed-line skip
// ---------------------------------------------------------------------------

describe("ledger I/O", () => {
  it("appendLedgerEntry and readLedger round-trip", () => {
    const cwd = tmpDir();
    appendLedgerEntry(cwd, {
      ts: "2026-07-20T10:00:00.000Z",
      runId: "r-1",
      classId: "commit-incomplete",
      signature: "commit incomplete <path>",
    });

    const entries = readLedger(cwd);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.runId).toBe("r-1");
    expect(entries[0]!.classId).toBe("commit-incomplete");
  });

  it("readLedger skips malformed lines", () => {
    const cwd = tmpDir();
    const ledPath = join(cwd, ".tanya", "doctor", "ledger.jsonl");
    mkdirSync(join(cwd, ".tanya", "doctor"), { recursive: true });
    writeFileSync(ledPath, 'garbage\n{"ts":"a","runId":"b","classId":"c","signature":"d"}\nnot-json');
    const entries = readLedger(cwd);
    // Only the valid JSON line should parse; garbage is skipped
    expect(entries).toHaveLength(1);
    expect(entries[0]!.runId).toBe("b");
  });

  it("deriveSignature uses first blocker line", () => {
    const evidence = fixtureEvidence({
      archive: fixtureArchive({
        blockers: [
          "Build verification failed: /src/app.ts:42: error TS2322",
          "Commit incomplete",
        ],
      }),
    });
    const sig = deriveSignature(["stall-blind-build"], evidence);
    expect(sig).toContain("build verification failed");
    expect(sig).not.toContain("commit incomplete");
  });

  it("deriveSignature falls back to class ids when no blockers", () => {
    const evidence = fixtureEvidence({
      archive: fixtureArchive({ blockers: [] }),
    });
    const sig = deriveSignature(["dead-run-dirty-tree"], evidence);
    expect(sig).toBe("dead-run-dirty-tree");
  });
});

// ---------------------------------------------------------------------------
// Escalation detection
// ---------------------------------------------------------------------------

describe("escalation", () => {
  it("no escalation when no prior entries exist", () => {
    const cwd = tmpDir();
    const evidence = fixtureEvidence({
      archive: fixtureArchive({
        blockers: ["Some unknown blocker"],
      }),
    });
    const result = checkEscalation(cwd, "r-1", ["unknown"], evidence);
    expect(result).toBeNull();
  });

  it("unknown class ×2 → escalation", () => {
    const cwd = tmpDir();
    const sig = "some unknown blocker";

    appendLedgerEntry(cwd, {
      ts: "2026-07-19T10:00:00.000Z",
      runId: "r-old",
      classId: "unknown",
      signature: sig,
    });

    const evidence = fixtureEvidence({
      archive: fixtureArchive({
        blockers: ["Some unknown blocker"],
      }),
    });
    const result = checkEscalation(cwd, "r-new", ["unknown"], evidence);
    expect(result).not.toBeNull();
    expect(result!.newUnknownClass).toBe(true);
    expect(result!.entries).toHaveLength(1);
    expect(result!.entries[0]!.runId).toBe("r-old");
  });

  it("known class ×3 in 7 days → nag", () => {
    const cwd = tmpDir();
    const evidence = fixtureEvidence({
      archive: fixtureArchive({
        blockers: ["Commit incomplete: files uncommitted — src/foo.swift"],
      }),
    });
    const sig = deriveSignature(["commit-incomplete"], evidence);

    // Recent entries (within 7 days)
    for (let i = 0; i < 2; i++) {
      appendLedgerEntry(cwd, {
        ts: new Date(Date.now() - (i + 1) * 24 * 60 * 60 * 1000).toISOString(),
        runId: `r-prior-${i}`,
        classId: "commit-incomplete",
        signature: sig,
      });
    }

    const result = checkEscalation(cwd, "r-now", ["commit-incomplete"], evidence);
    expect(result).not.toBeNull();
    expect(result!.knownClassNag).toBe(true);
    expect(result!.newUnknownClass).toBe(false);
    expect(result!.entries).toHaveLength(2);
  });

  it("known class ×2 only → no nag yet", () => {
    const cwd = tmpDir();
    const evidence = fixtureEvidence({
      archive: fixtureArchive({
        blockers: ["Commit incomplete: files uncommitted — src/foo.swift"],
      }),
    });
    const sig = deriveSignature(["commit-incomplete"], evidence);

    appendLedgerEntry(cwd, {
      ts: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      runId: "r-prior",
      classId: "commit-incomplete",
      signature: sig,
    });

    const result = checkEscalation(cwd, "r-now", ["commit-incomplete"], evidence);
    expect(result).toBeNull();
  });

  it("known class ×3 but older than 7 days → no nag", () => {
    const cwd = tmpDir();
    const evidence = fixtureEvidence({
      archive: fixtureArchive({
        blockers: ["Commit incomplete: files uncommitted — src/foo.swift"],
      }),
    });
    const sig = deriveSignature(["commit-incomplete"], evidence);

    // Old entries (>7 days ago)
    for (let i = 0; i < 2; i++) {
      appendLedgerEntry(cwd, {
        ts: new Date(Date.now() - (8 + i) * 24 * 60 * 60 * 1000).toISOString(),
        runId: `r-old-${i}`,
        classId: "commit-incomplete",
        signature: sig,
      });
    }

    const result = checkEscalation(cwd, "r-now", ["commit-incomplete"], evidence);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runDoctor integration: ledger + improvement drafts
// ---------------------------------------------------------------------------

describe("runDoctor with ledger", () => {
  it("appends a ledger entry on every doctor invocation", () => {
    const cwd = tmpDir();
    writeRunsDir(cwd, "r-single", {
      runId: "r-single",
      verdict: "FAIL",
      blockers: ["Commit incomplete: files uncommitted — src/a.ts"],
      changedFiles: ["src/a.ts"],
    });

    runDoctor({ cwd, runId: "r-single" });

    const entries = readLedger(cwd);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const commitEntry = entries.find((e) => e.classId === "commit-incomplete");
    expect(commitEntry).toBeDefined();
    expect(commitEntry!.runId).toBe("r-single");
  });

  it("unknown class ×2 writes improvement draft", () => {
    const cwd = tmpDir();

    // First run: unknown failure
    writeRunsDir(cwd, "r-1", {
      runId: "r-1",
      verdict: "FAIL",
      blockers: ["Tool output truncated: command produced 50000 bytes"],
      changedFiles: ["src/a.ts"],
    });
    runDoctor({ cwd, runId: "r-1" });

    // Second run: same unknown failure — should escalate
    writeRunsDir(cwd, "r-2", {
      runId: "r-2",
      verdict: "FAIL",
      blockers: ["Tool output truncated: command produced 60000 bytes"],
      changedFiles: ["src/b.ts"],
    });
    const diagnosis = runDoctor({ cwd, runId: "r-2" });

    // Should contain escalation nag
    expect(diagnosis.explanation).toContain("Escalation");
    expect(diagnosis.classes).toContain("unknown");

    // Improvement draft should exist
    const doctorDir = join(cwd, ".tanya", "doctor");
    const files = readdirSync(doctorDir).filter((f) => f.startsWith("improvement-") && f.endsWith(".md"));
    expect(files.length).toBeGreaterThanOrEqual(1);

    // Draft contains both runs' evidence
    const draftFile = files[0]!;
    const draftContent = readFileSync(join(doctorDir, draftFile), "utf8");
    expect(draftContent).toContain("unknown");
    // Draft has the required header guard
    expect(draftContent).toContain("Doctor never edits Tanya's own source");
  });

  it("known class ×3 in window writes improvement draft and nag", () => {
    const cwd = tmpDir();

    // Three commit-incomplete failures in rapid succession
    for (let i = 1; i <= 3; i++) {
      const blocker = `Commit incomplete: files uncommitted — src/file${i}.ts`;
      writeRunsDir(cwd, `r-${i}`, {
        runId: `r-${i}`,
        verdict: "FAIL",
        blockers: [blocker],
        changedFiles: [`src/file${i}.ts`],
      });
      // Ramp up timestamps — i days ago
      const fakeLedgerEntry = {
        ts: new Date(Date.now() - (3 - i + 1) * 24 * 60 * 60 * 1000).toISOString(),
        runId: `r-${i}`,
        classId: "commit-incomplete",
        signature: normalizeSignature(blocker),
      };
      if (i < 3) {
        appendLedgerEntry(cwd, fakeLedgerEntry);
      }
    }

    // Run doctor on the third — should nag
    const diagnosis = runDoctor({ cwd, runId: "r-3" });
    // The runDoctor itself appends a ledger entry, so the escalation should fire
    // based on the manually injected entries + the auto-added one.
    // To be deterministic, let's check: at least one of the prior two injected
    // entries combined with the auto-appended one should trigger the nag.
    // Actually runDoctor calls appendLedgerEntry for each class BEFORE checkEscalation.
    // So r-1 and r-2 are manually injected, r-3 is auto-appended → 3 total → nag.
    const doctorDir = join(cwd, ".tanya", "doctor");
    const files = readdirSync(doctorDir).filter((f) => f.startsWith("improvement-") && f.endsWith(".md"));

    // Should have escalation
    expect(files.length).toBeGreaterThanOrEqual(1);

    // Diagnosis should mention recurrence
    expect(diagnosis.explanation).toContain("Recurring known class");
  });

  it("stale marker over clean tree → diagnosis but no escalation", () => {
    const cwd = tmpDir();
    writeMarker(cwd, "LAST_RUN_FAILED.md", "Stale marker — user fixed by hand");

    const diagnosis = runDoctor({ cwd });

    // Should classify as dead-run-dirty-tree (marker present)
    expect(diagnosis.classes).toContain("dead-run-dirty-tree");

    // But no escalation (only one entry)
    expect(diagnosis.explanation).not.toContain("Escalation");
  });
});

// ---------------------------------------------------------------------------
// ledgerSummary (--list)
// ---------------------------------------------------------------------------

describe("ledgerSummary", () => {
  it("reports empty ledger", () => {
    const cwd = tmpDir();
    const summary = ledgerSummary(cwd);
    expect(summary).toContain("No entries yet");
  });

  it("reports class counts and recent signatures", () => {
    const cwd = tmpDir();
    appendLedgerEntry(cwd, {
      ts: "2026-07-20T10:00:00.000Z",
      runId: "r-1",
      classId: "commit-incomplete",
      signature: "commit incomplete <path>",
    });
    appendLedgerEntry(cwd, {
      ts: "2026-07-20T11:00:00.000Z",
      runId: "r-2",
      classId: "stall-blind-build",
      signature: "build verification failed <path>",
    });

    const summary = ledgerSummary(cwd);
    expect(summary).toContain("Total entries: 2");
    expect(summary).toContain("commit-incomplete");
    expect(summary).toContain("stall-blind-build");
    expect(summary).toContain("r-1");
    expect(summary).toContain("r-2");
  });

  it("lists pending improvement drafts", () => {
    const cwd = tmpDir();
    appendLedgerEntry(cwd, {
      ts: "2026-07-20T10:00:00.000Z",
      runId: "r-1",
      classId: "unknown",
      signature: "some unknown",
    });
    // Manually write an improvement draft
    const doctorDir = join(cwd, ".tanya", "doctor");
    writeFileSync(join(doctorDir, "improvement-test-slug.md"), "# Draft");

    const summary = ledgerSummary(cwd);
    expect(summary).toContain("Pending improvement drafts");
    expect(summary).toContain("improvement-test-slug.md");
  });
});
