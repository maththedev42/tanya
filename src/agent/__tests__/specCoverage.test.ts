import { describe, expect, it } from "vitest";
import { assessCoverage, parseSpecRequirements, renderCoverageTable } from "../specCoverage";
import { ensureCodingReport } from "../report";
import type { TanyaFinalManifest } from "../runner";

function manifest(overrides: Partial<TanyaFinalManifest> = {}): TanyaFinalManifest {
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
    ...overrides,
  } as TanyaFinalManifest;
}

describe("parseSpecRequirements", () => {
  it("extracts Part N and ### ID-NN headings, ignoring prose/context headings", () => {
    const prompt = [
      "## Context — what went wrong",
      "## Part 1 — Verify-gate",
      "## Part 2: Commit hardening",
      "### G1 — Spec Manifest gate (kills F1)",
      "### TANYA-04 (P1) — Readiness gates",
      "## Verify",
      "**F1 — Silent task skipping.**", // bold, not a heading → ignored
    ].join("\n");
    const reqs = parseSpecRequirements(prompt);
    expect(reqs.map((r) => r.id)).toEqual(["Part 1", "Part 2", "G1", "TANYA-04"]);
    expect(reqs[0]?.title).toBe("Verify-gate");
  });

  it("returns nothing for a prompt with no deliverable headings", () => {
    expect(parseSpecRequirements("Please fix the login bug and add a test.")).toEqual([]);
  });
});

describe("assessCoverage", () => {
  const reqs = parseSpecRequirements("## Part 1 — Verify gate\n## Part 2 — Commit hardening\n## Part 3 — Localization checks");

  it("marks a requirement done when its id is mentioned", () => {
    const cov = assessCoverage(reqs, "Part 1 done. Part 2 done via commit hardening. Part 3 done: localization.");
    expect(cov.every((c) => c.status === "done")).toBe(true);
  });

  it("marks a requirement done when a majority of its title words appear", () => {
    const cov = assessCoverage(reqs, "Implemented the verify gate and commit hardening and localization checks.");
    expect(cov.every((c) => c.status === "done")).toBe(true);
  });

  it("marks pending when a requirement is never accounted for", () => {
    const cov = assessCoverage(reqs, "Part 1 verify gate done. Part 2 commit hardening done.");
    const p3 = cov.find((c) => c.id === "Part 3");
    expect(p3?.status).toBe("pending");
  });

  it("marks skipped when the mention says skipped/deferred", () => {
    const cov = assessCoverage(reqs, "Part 1 done. Part 2 done. Part 3 skipped — no localization files in this repo.");
    expect(cov.find((c) => c.id === "Part 3")?.status).toBe("skipped");
  });
});

describe("ensureCodingReport — coverage gate (F4 acceptance: 1 of 3 pending blocks SUCCESS)", () => {
  const reqs = parseSpecRequirements("## Part 1 — Verify gate\n## Part 2 — Commit hardening\n## Part 3 — Localization checks");

  it("blocks the verdict and names the pending deliverable", () => {
    const m = manifest({ specRequirements: reqs });
    // Report accounts for Part 1 and Part 2 but omits Part 3 entirely.
    const report = "Part 1 verify gate: done. Part 2 commit hardening: done.";
    const out = ensureCodingReport(report, m, undefined);
    expect(out).toMatch(/TANYA RESULT:\s*FAIL/);
    expect(m.blockers.some((b) => /Spec coverage incomplete/.test(b))).toBe(true);
    expect(m.blockers.some((b) => b.includes("Part 3"))).toBe(true);
    expect(m.specCoverage?.find((c) => c.id === "Part 3")?.status).toBe("pending");
    expect(out).toContain("Spec coverage:"); // the table renders
  });

  it("passes when every deliverable is accounted for", () => {
    const m = manifest({ specRequirements: reqs });
    const report = "Part 1 verify gate done. Part 2 commit hardening done. Part 3 localization checks done.";
    const out = ensureCodingReport(report, m, undefined);
    expect(out).toMatch(/TANYA RESULT:\s*PASSED/);
    expect(m.blockers.some((b) => /Spec coverage/.test(b))).toBe(false);
  });

  it("is inert when the manifest carries no spec requirements", () => {
    const m = manifest();
    const out = ensureCodingReport("did the thing", m, undefined);
    expect(m.specCoverage).toBeUndefined();
    expect(m.blockers.some((b) => /Spec coverage/.test(b))).toBe(false);
    expect(out).toMatch(/TANYA RESULT:\s*PASSED/);
  });
});

describe("renderCoverageTable", () => {
  it("marks pending items prominently", () => {
    const table = renderCoverageTable([
      { id: "Part 1", title: "Verify gate", status: "done" },
      { id: "Part 2", title: "Commit", status: "skipped" },
      { id: "Part 3", title: "L10n", status: "pending" },
    ]);
    expect(table).toContain("✓ done — Part 1");
    expect(table).toContain("◌ skipped — Part 2");
    expect(table).toContain("✗ PENDING — Part 3");
  });
});
