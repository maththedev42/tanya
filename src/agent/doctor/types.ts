// Shared types for the doctor module.

export type RunArchive = {
  runId: string;
  aborted?: boolean;
  verdict?: "PASSED" | "FAIL";
  terminationReason?: string;
  prompt?: string;
  changedFiles?: string[];
  uncommittedFiles?: string[];
  greenBuildObserved?: boolean;
  blockers?: string[];
  childVerdicts?: Array<{
    label?: string;
    runId?: string;
    verdict: string;
    blockers?: string[];
  }>;
  gates?: Record<string, {
    armed?: boolean;
    passed?: boolean;
    reason?: string;
    covered?: number;
    total?: number;
  }>;
  toolCallCount?: number;
  gateLog?: string[];
};

export type ForbiddenPatternHit = {
  file: string;
  pattern: string;
  /** 1-based line of the first single-line match; absent when the pattern
   *  only matches across lines. */
  line?: number;
  match?: string;
  suggestion?: string;
};

export type DiagnosisEvidence = {
  /** The run archive (aborted or completed). Null if none found. */
  archive: RunArchive | null;
  /** Marker file presence in the target cwd/repo. */
  markers: {
    lastRunFailed: boolean;
    runInProgress: boolean;
    runInProgressPidAlive: boolean;
  };
  /** Error lines extracted from build failures in the archive blockers. */
  buildErrors: string[];
  /** Forbidden-pattern hits found in current file content. */
  forbiddenPatternHits: ForbiddenPatternHit[];
};

export type FailureClass = {
  id: string;
  /** Returns true when the evidence matches this class. */
  detect(evidence: DiagnosisEvidence): boolean;
  /** Human-readable explanation of what happened. */
  explain(evidence: DiagnosisEvidence): string;
  /** A ready-to-dispatch repair prompt in house style. */
  prescribe(evidence: DiagnosisEvidence): string;
};

export type Diagnosis = {
  runId: string;
  classes: string[];
  explanation: string;
  repairPrompt: string;
};

export type DoctorOptions = {
  /** Target run id. If omitted, finds the most recent non-PASSED run. */
  runId?: string;
  /** Working directory. Defaults to process.cwd(). */
  cwd?: string;
};
