import { describe, expect, it } from "vitest";
import {
  commitCompletenessSection,
  specCoverageSection,
  validationSection,
  verifyGateSection,
} from "../gateReport";
import type { CoverageItem } from "../specCoverage";

describe("gateReport sections (structured archive verdicts)", () => {
  it("verify-gate is skipped when no required commands, pass when all verified, fail otherwise", () => {
    expect(verifyGateSection([]).status).toBe("skipped");
    expect(verifyGateSection([{ cmd: "npm test", verified: true }]).status).toBe("pass");
    expect(
      verifyGateSection([
        { cmd: "npm test", verified: true },
        { cmd: "go build ./...", verified: false },
      ]).status,
    ).toBe("fail");
  });

  it("commit-completeness flattens uncommitted files to absolute paths and fails when any remain", () => {
    const clean = commitCompletenessSection([]);
    expect(clean.status).toBe("pass");
    expect(clean.uncommitted).toEqual([]);

    const dirty = commitCompletenessSection([{ repoRoot: "/repo", files: ["src/a.ts", "src/b.ts"] }]);
    expect(dirty.status).toBe("fail");
    expect(dirty.uncommitted).toEqual(["/repo/src/a.ts", "/repo/src/b.ts"]);
  });

  it("spec-coverage mirrors the coverage manifest and fails on any pending item", () => {
    const items: CoverageItem[] = [
      { id: "Part 1", title: "do a thing", status: "done", evidence: "did the thing" },
      { id: "Part 2", title: "skip a thing", status: "skipped" },
      { id: "Part 3", title: "forgot", status: "pending", repeatOffense: true },
    ];
    const section = specCoverageSection(items);
    expect(section.status).toBe("fail");
    expect(section.items).toHaveLength(3);
    expect(section.items[0]).toMatchObject({ id: "Part 1", text: "do a thing", state: "done", evidence: "did the thing" });
    expect(section.items[2]).toMatchObject({ id: "Part 3", state: "pending", repeatOffense: true });

    const allDone = specCoverageSection([{ id: "Part 1", title: "x", status: "done" }]);
    expect(allDone.status).toBe("pass");
  });

  it("validation section fails when gating errors are present", () => {
    expect(validationSection([]).status).toBe("pass");
    expect(validationSection(["localization-missing: x"]).status).toBe("fail");
  });
});
