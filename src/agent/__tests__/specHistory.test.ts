import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markRepeatOffenders, recordCoverageHistory } from "../specHistory";
import { renderCoverageTable, type CoverageItem, type SpecRequirement } from "../specCoverage";

function ws(): string {
  return mkdtempSync(join(tmpdir(), "tanya-spechist-"));
}

const req = (id: string): SpecRequirement => ({ id, title: id });
const item = (id: string, status: CoverageItem["status"]): CoverageItem => ({ id, title: id, status });

describe("recordCoverageHistory + markRepeatOffenders (E7 — repeat offenders)", () => {
  it("marks an item that was pending in a prior run and is unfinished again", () => {
    const dir = ws();
    // Run 1: TANYA-06 pending, TANYA-01 done.
    recordCoverageHistory(dir, [item("TANYA-06", "pending"), item("TANYA-01", "done")]);
    // Run 2: TANYA-06 still pending → repeat offense.
    const marked = markRepeatOffenders(dir, [req("TANYA-06"), req("TANYA-01")], [
      item("TANYA-06", "pending"),
      item("TANYA-01", "done"),
    ]);
    expect(marked.find((i) => i.id === "TANYA-06")?.repeatOffense).toBe(true);
    expect(marked.find((i) => i.id === "TANYA-01")?.repeatOffense).toBeUndefined();
  });

  it("normalizes ids so TANYA-6 / TANYA-06 / 'tanya 6' collapse", () => {
    const dir = ws();
    recordCoverageHistory(dir, [item("TANYA-06", "skipped")]);
    const marked = markRepeatOffenders(dir, [req("tanya 6")], [item("tanya 6", "pending")]);
    expect(marked[0]?.repeatOffense).toBe(true);
  });

  it("does not mark an item now completed", () => {
    const dir = ws();
    recordCoverageHistory(dir, [item("G1", "pending")]);
    const marked = markRepeatOffenders(dir, [req("G1")], [item("G1", "done")]);
    expect(marked[0]?.repeatOffense).toBeUndefined();
  });

  it("does not mark on a fresh workspace with no history", () => {
    const dir = ws();
    const marked = markRepeatOffenders(dir, [req("G1")], [item("G1", "pending")]);
    expect(marked[0]?.repeatOffense).toBeUndefined();
  });

  it("renders the repeat-offense marker LOUDLY in the coverage table", () => {
    const dir = ws();
    recordCoverageHistory(dir, [item("TANYA-06", "pending")]);
    const marked = markRepeatOffenders(dir, [req("TANYA-06")], [item("TANYA-06", "pending")]);
    const table = renderCoverageTable(marked);
    expect(table).toContain("TANYA-06");
    expect(table).toContain("repeat-offense");
  });

  it("persists history to .tanya/spec-coverage-history.json and caps its length", () => {
    const dir = ws();
    for (let i = 0; i < 15; i += 1) recordCoverageHistory(dir, [item(`X-${i}`, "done")]);
    const path = join(dir, ".tanya/spec-coverage-history.json");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { runs: unknown[] };
    expect(parsed.runs.length).toBeLessThanOrEqual(12);
  });
});
