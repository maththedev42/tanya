import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isComplete,
  ledgerPath,
  loadLedger,
  normalizeLedger,
  remainingSteps,
  renderLedger,
  resumeSummary,
  saveLedger,
} from "../taskLedger";

describe("taskLedger (pure)", () => {
  it("normalizes statuses and drops empty steps", () => {
    const ledger = normalizeLedger([
      { text: "scaffold", status: "done" },
      { text: "  ", status: "pending" },
      { text: "build", status: "bogus" as unknown as string },
    ]);
    expect(ledger.steps).toEqual([
      { text: "scaffold", status: "done" },
      { text: "build", status: "pending" }, // invalid status -> pending
    ]);
  });

  it("computes remaining and completeness", () => {
    const ledger = normalizeLedger([
      { text: "a", status: "done" },
      { text: "b", status: "in_progress" },
    ]);
    expect(remainingSteps(ledger).map((s) => s.text)).toEqual(["b"]);
    expect(isComplete(ledger)).toBe(false);
    expect(isComplete(normalizeLedger([{ text: "a", status: "done" }]))).toBe(true);
  });

  it("renders a checklist and a resume summary", () => {
    const ledger = normalizeLedger([
      { text: "create project", status: "done" },
      { text: "wire calculator logic", status: "pending" },
    ]);
    expect(renderLedger(ledger)).toBe("[x] 1. create project\n[ ] 2. wire calculator logic");
    const summary = resumeSummary(ledger);
    expect(summary).toContain("Completed: (1) create project");
    expect(summary).toContain("Remaining: (1) wire calculator logic");
  });
});

describe("taskLedger (persistence)", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "tanya-ledger-"));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("round-trips through the workspace", async () => {
    const ledger = normalizeLedger([{ text: "step one", status: "in_progress" }]);
    await saveLedger(workspace, ledger);
    const loaded = await loadLedger(workspace);
    expect(loaded).toEqual(ledger);
    const onDisk = await readFile(ledgerPath(workspace), "utf8");
    expect(onDisk).toContain("step one");
  });

  it("returns null when no ledger exists", async () => {
    expect(await loadLedger(workspace)).toBeNull();
  });

  it("stores the plan under the gitignored .tanya runtime dir", () => {
    expect(ledgerPath(workspace)).toContain(".tanya/");
    expect(ledgerPath(workspace)).not.toContain(".tania/");
  });

  it("falls back to reading a legacy .tania/plan.json", async () => {
    const legacyDir = join(workspace, ".tania");
    await mkdir(legacyDir, { recursive: true });
    const ledger = normalizeLedger([{ text: "legacy step", status: "done" }]);
    await writeFile(join(legacyDir, "plan.json"), JSON.stringify(ledger), "utf8");
    expect(await loadLedger(workspace)).toEqual(ledger);
  });

  it("prefers the current .tanya ledger over a legacy one", async () => {
    const legacyDir = join(workspace, ".tania");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      join(legacyDir, "plan.json"),
      JSON.stringify(normalizeLedger([{ text: "stale", status: "pending" }])),
      "utf8",
    );
    const current = normalizeLedger([{ text: "fresh", status: "in_progress" }]);
    await saveLedger(workspace, current);
    expect(await loadLedger(workspace)).toEqual(current);
  });
});
