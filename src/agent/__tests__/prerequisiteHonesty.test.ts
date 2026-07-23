import { describe, expect, it } from "vitest";
import { assessCoverage, parseSpecRequirements, renderCoverageTable } from "../specCoverage";

// Prerequisite honesty (PROMPT B item 3). The audited failure reported PASS on
// a checklist item that depended on prompts that never ran — implementing a
// slice of the OTHER prompt just to green the checkbox.

const PROMPT = [
  "## Part 1 — banner",
  "Build the banner.",
  "",
  "## Part 2 — deep links (requires T3)",
  "If T3 has landed, wire the banner tap to the deep-link router.",
  "",
  "## Part 3 — cleanup",
  "After Part 1, remove the old banner. Internal ordering only.",
].join("\n");

describe("parseSpecRequirements — conditionalOn", () => {
  it("marks a cross-prompt prerequisite from the title", () => {
    const reqs = parseSpecRequirements(PROMPT);
    expect(reqs.find((r) => r.id === "Part 2")?.conditionalOn).toBe("T3");
  });

  it("a reference to one of the prompt's OWN sections is internal ordering, not a prerequisite", () => {
    const reqs = parseSpecRequirements(PROMPT);
    expect(reqs.find((r) => r.id === "Part 3")?.conditionalOn).toBeUndefined();
  });

  it("detects the prerequisite from the section body too", () => {
    const reqs = parseSpecRequirements([
      "## Part 1 — sync",
      "Blocked by OPUS-03. Wire the sync once it exists.",
    ].join("\n"));
    // Single requirement → coverage gate needs ≥2, but parsing must still mark it.
    expect(reqs[0]?.conditionalOn).toBe("OPUS-03");
  });
});

describe("assessCoverage — prerequisite downgrade", () => {
  const reqs = parseSpecRequirements(PROMPT);

  it("a conditional item claimed done WITHOUT prerequisite evidence is downgraded to skipped", () => {
    const report = [
      "Part 1: banner built.",
      "Part 2: deep links wired — done.",
      "Part 3: old banner removed.",
    ].join("\n");
    const coverage = assessCoverage(reqs, report);
    const part2 = coverage.find((item) => item.id === "Part 2");
    expect(part2?.status).toBe("skipped");
    expect(part2?.prerequisiteUnmet).toBe(true);
    expect(part2?.evidence).toContain("prerequisite T3 not evidenced");
    // The unconditional items keep their normal assessment.
    expect(coverage.find((item) => item.id === "Part 1")?.status).toBe("done");
    expect(coverage.find((item) => item.id === "Part 3")?.status).toBe("done");
  });

  it("stays done when the report evidences the prerequisite as satisfied", () => {
    const report = [
      "Part 1: banner built.",
      "T3 already landed (router present in src/router.ts), so Part 2: deep links wired — done.",
      "Part 3: old banner removed.",
    ].join("\n");
    const part2 = assessCoverage(reqs, report).find((item) => item.id === "Part 2");
    expect(part2?.status).toBe("done");
    expect(part2?.prerequisiteUnmet).toBeUndefined();
  });

  it("the downgrade is skipped, NEVER pending — it cannot add a blocker", () => {
    const report = "Part 1: done. Part 2: done. Part 3: done.";
    const coverage = assessCoverage(reqs, report);
    expect(coverage.every((item) => item.status !== "pending")).toBe(true);
  });

  it("renders the downgrade warning in the coverage table", () => {
    const report = "Part 1: done. Part 2: done. Part 3: done.";
    const table = renderCoverageTable(assessCoverage(reqs, report));
    expect(table).toContain("prerequisite not evidenced — cannot self-certify as done");
  });
});
