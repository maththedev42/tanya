import { describe, expect, it } from "vitest";
import {
  additiveEditNudges,
  isAdditiveInstrumentationPrompt,
  removedLinesFromDiff,
} from "../additiveEdit";

describe("isAdditiveInstrumentationPrompt", () => {
  it("matches instrumentation-shaped prompts (en + pt)", () => {
    expect(isAdditiveInstrumentationPrompt("F1 — funnel analytics: add GA4 events to the paywall")).toBe(true);
    expect(isAdditiveInstrumentationPrompt("Adicionar telemetria de onboarding")).toBe(true);
    expect(isAdditiveInstrumentationPrompt("Instrumentar o funil de cadastro com eventos")).toBe(true);
    expect(isAdditiveInstrumentationPrompt("Wire PostHog tracking events for checkout")).toBe(true);
    expect(isAdditiveInstrumentationPrompt("Add Firebase Analytics to the app")).toBe(true);
  });

  it("does not match ordinary coding tasks", () => {
    expect(isAdditiveInstrumentationPrompt("Fix the login 500 on empty password")).toBe(false);
    expect(isAdditiveInstrumentationPrompt("Refactor the parser to drop the legacy branch")).toBe(false);
    expect(isAdditiveInstrumentationPrompt("Add a settings screen with dark mode")).toBe(false);
  });
});

const DIFF = [
  "diff --git a/App/AuthStore.swift b/App/AuthStore.swift",
  "index 111..222 100644",
  "--- a/App/AuthStore.swift",
  "+++ b/App/AuthStore.swift",
  "@@ -10,8 +10,7 @@",
  " context line",
  "-        errorMessage = mapAuthError(error)",
  "-    ",
  "+        Analytics.log(.registerFailed)",
  " another context line",
  "diff --git a/App/Removed.swift b/App/Removed.swift",
  "deleted file mode 100644",
  "--- a/App/Removed.swift",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-struct Removed {}",
  "-",
].join("\n");

describe("removedLinesFromDiff", () => {
  it("collects removed non-whitespace lines with file attribution", () => {
    const removals = removedLinesFromDiff(DIFF);
    expect(removals).toEqual([
      { file: "App/AuthStore.swift", line: "errorMessage = mapAuthError(error)" },
      { file: "App/Removed.swift", line: "struct Removed {}" },
    ]);
  });

  it("skips whitespace-only removals and pure additions", () => {
    const removals = removedLinesFromDiff([
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,2 @@",
      "-   ",
      "+added()",
    ].join("\n"));
    expect(removals).toEqual([]);
  });
});

describe("additiveEditNudges", () => {
  it("returns [] with no removals", () => {
    expect(additiveEditNudges([])).toEqual([]);
  });

  it("lists removals, capped, with the restore-or-justify instruction", () => {
    const removals = Array.from({ length: 10 }, (_, i) => ({ file: "a.swift", line: `removed${i}()` }));
    const nudges = additiveEditNudges(removals, 3);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain("removed0()");
    expect(nudges[0]).toContain("(+7 more)");
    expect(nudges[0]).toContain("restore each removed line or justify");
  });
});
