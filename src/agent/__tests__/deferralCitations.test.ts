import { describe, expect, it } from "vitest";
import { deferralCitationNudges } from "../deferralCitations";
import { ensureCodingReport } from "../report";
import type { TanyaFinalManifest } from "../runner";

// Deferral citations (PROMPT B item 4). The audited failure justified skipping
// a T2 requirement with a fabricated "Tier 3" scope quote that appears nowhere
// in the prompt.

const PROMPT = [
  "## T2 — notifications",
  "Implement the push notification banner.",
  "Out of scope for this prompt: analytics dashboards and billing.",
].join("\n");

describe("deferralCitationNudges", () => {
  it("flags a fabricated scope quote (the audited 'Tier 3' shape)", () => {
    const report = 'Banner: skipped — deferred as "Tier 3 polish items" per the spec.';
    const nudges = deferralCitationNudges(report, PROMPT);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain("unsupported deferral");
    expect(nudges[0]).toContain("Tier 3 polish items");
  });

  it("accepts a deferral whose quote is literally in the prompt (punctuation-insensitive)", () => {
    const report = 'Dashboards deferred: the prompt says "Out of scope for this prompt: analytics dashboards" — not doing them.';
    expect(deferralCitationNudges(report, PROMPT)).toEqual([]);
  });

  it("flags a scope-exclusion claim with no quote at all", () => {
    const report = "Billing: out of scope per the task, skipping.";
    const nudges = deferralCitationNudges(report, PROMPT);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain("without quoting the prompt");
  });

  it("leaves an honest operational skip (no scope claim, no quote) alone", () => {
    const report = "Live probe skipped: no API key available in this environment.";
    expect(deferralCitationNudges(report, PROMPT)).toEqual([]);
  });

  it("ignores incidental short quotes on non-deferral lines", () => {
    const report = 'Renamed the button label to "Send" and committed.';
    expect(deferralCitationNudges(report, PROMPT)).toEqual([]);
  });

  it("returns [] without a prompt to check against", () => {
    expect(deferralCitationNudges('deferred per "whatever"', "")).toEqual([]);
  });
});

describe("deferral nudges through ensureCodingReport", () => {
  function manifest(): TanyaFinalManifest {
    return {
      schemaVersion: 1,
      changedFiles: ["a.ts"],
      uncommittedFiles: [],
      artifactsRead: [],
      artifactsCreated: [],
      contextFilesRead: [],
      verification: ["Verification: npm test -> passed"],
      git: { root: "/repo", head: "abc1234" },
      toolErrors: 0,
      blockers: [],
      gateLog: [],
      gates: { armed: true, armedReason: "test" },
    } as TanyaFinalManifest;
  }

  it("renders the unsupported-deferral note in the footer and stays non-gating", () => {
    const m = manifest();
    const body = 'Done with Part 1. Part 2 deferred as "Tier 3 polish" per the spec.';
    const out = ensureCodingReport(body, m, undefined, { prompt: PROMPT });
    expect(out).toContain("Note: unsupported deferral");
    expect(out).toContain("TANYA RESULT: PASSED"); // nudge, never a verdict flip
    expect(m.gates?.deferralCitations?.nudges.length ?? 0).toBeGreaterThan(0);
  });
});
