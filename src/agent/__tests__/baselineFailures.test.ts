import { describe, expect, it } from "vitest";
import {
  allFailingPackagesUntouched,
  isBroadGoTestCommand,
  packagesTouchedByRun,
  parseGoTestFailures,
  untouchedFailingPackages,
} from "../baselineFailures";

const APPLE_TEST_OUTPUT = `
--- FAIL: TestSubmitForReview_UsesReviewSubmissionFlow (0.00s)
    client_test.go:288: unexpected request: GET /reviewSubmissions/review-1/items
--- FAIL: TestSubmitForReview_ReusesDraftAndCancelsOthers (0.00s)
    client_test.go:362: unexpected request: GET /reviewSubmissions/review-ios/items
    client_test.go:362: unexpected request: GET /reviewSubmissions/review-empty/items
FAIL
FAIL	github.com/cosmohq/cosmohq-v3/api/internal/store/apple	4.869s
`;

describe("parseGoTestFailures", () => {
  it("extracts the failing package import path, not test names or the bare FAIL summary", () => {
    expect(parseGoTestFailures(APPLE_TEST_OUTPUT)).toEqual([
      "github.com/cosmohq/cosmohq-v3/api/internal/store/apple",
    ]);
  });

  it("collects multiple distinct failing packages from a broad run", () => {
    const output = [
      "ok  \tgithub.com/x/api/internal/coding\t0.010s",
      "FAIL\tgithub.com/x/api/internal/store/apple\t4.869s",
      "FAIL\tgithub.com/x/api/internal/growth [build failed]",
    ].join("\n");
    expect(parseGoTestFailures(output).sort()).toEqual([
      "github.com/x/api/internal/growth",
      "github.com/x/api/internal/store/apple",
    ]);
  });

  it("returns empty for output with no FAIL lines", () => {
    expect(parseGoTestFailures("ok  \tgithub.com/x/api/internal/coding\t0.010s\n")).toEqual([]);
  });

  it("deduplicates a package that appears in multiple FAIL lines", () => {
    const output = "FAIL\tgithub.com/x/api/internal/apple\t1s\nFAIL\tgithub.com/x/api/internal/apple\t1s\n";
    expect(parseGoTestFailures(output)).toEqual(["github.com/x/api/internal/apple"]);
  });
});

describe("isBroadGoTestCommand", () => {
  it("recognizes the wildcard shape, with or without a leading cd hop", () => {
    expect(isBroadGoTestCommand("go test ./internal/...")).toBe(true);
    expect(isBroadGoTestCommand("go test ./...")).toBe(true);
    expect(isBroadGoTestCommand("cd api && go test ./internal/...")).toBe(true);
  });

  it("rejects a command already scoped to specific packages", () => {
    expect(isBroadGoTestCommand("go test ./internal/coding/...")).toBe(true); // still wildcarded, but scoped — caller decides via touched-package check
    expect(isBroadGoTestCommand("go test ./internal/coding")).toBe(false);
    expect(isBroadGoTestCommand("go test ./internal/coding ./internal/v1wizard")).toBe(false);
  });

  it("rejects non-go-test commands", () => {
    expect(isBroadGoTestCommand("npm test")).toBe(false);
    expect(isBroadGoTestCommand("go build ./...")).toBe(false);
    expect(isBroadGoTestCommand("go vet ./...")).toBe(false);
  });
});

describe("packagesTouchedByRun", () => {
  it("returns the directory of each changed .go file", () => {
    expect(packagesTouchedByRun(["api/internal/coding/store.go", "api/internal/coding/handler.go"])).toEqual([
      "api/internal/coding",
    ]);
  });

  it("ignores non-.go files and root-level .go files with no directory suffix", () => {
    expect(packagesTouchedByRun(["README.md", "main.go", "api/internal/v1wizard/types.go"])).toEqual([
      "api/internal/v1wizard",
    ]);
  });

  it("returns empty for no changed files", () => {
    expect(packagesTouchedByRun([])).toEqual([]);
  });
});

describe("untouchedFailingPackages / allFailingPackagesUntouched", () => {
  const failing = ["github.com/cosmohq/cosmohq-v3/api/internal/store/apple"];

  it("matches a failing package by suffix against a touched directory", () => {
    expect(untouchedFailingPackages(failing, ["api/internal/store/apple"])).toEqual([]);
    expect(allFailingPackagesUntouched(failing, ["api/internal/store/apple"])).toBe(false);
  });

  it("leaves a failing package untouched when the touched dirs are unrelated", () => {
    expect(untouchedFailingPackages(failing, ["api/internal/coding"])).toEqual(failing);
    expect(allFailingPackagesUntouched(failing, ["api/internal/coding"])).toBe(true);
  });

  it("requires ALL failing packages untouched — a single touched failure fails the check", () => {
    const twoFailing = [
      "github.com/x/api/internal/store/apple",
      "github.com/x/api/internal/coding",
    ];
    // internal/coding IS touched -> not all-untouched, even though apple isn't.
    expect(allFailingPackagesUntouched(twoFailing, ["api/internal/coding"])).toBe(false);
  });

  it("is false when there are no failing packages at all (nothing to reclassify)", () => {
    expect(allFailingPackagesUntouched([], ["api/internal/coding"])).toBe(false);
  });
});
