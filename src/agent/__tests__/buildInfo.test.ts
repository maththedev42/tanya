import { describe, expect, it } from "vitest";
import { computeStale, DEV_BUILD_ID, staleBinaryWarning } from "../buildInfo";

describe("stale-binary detection", () => {
  it("a dev build is never stale (nothing meaningful to compare)", () => {
    expect(computeStale(DEV_BUILD_ID, { buildId: "anything", version: "9.9.9" })).toBe(false);
  });

  it("a missing or id-less sidecar is never stale", () => {
    expect(computeStale("abc123", null)).toBe(false);
    expect(computeStale("abc123", {})).toBe(false);
  });

  it("matching build ids are current; differing ids are stale", () => {
    expect(computeStale("abc123", { buildId: "abc123", version: "1.0.0" })).toBe(false);
    expect(computeStale("abc123", { buildId: "def456", version: "1.1.0" })).toBe(true);
  });

  it("staleBinaryWarning names both versions when stale, and is null when current", () => {
    const stale = staleBinaryWarning({
      stale: true,
      running: { buildId: "abc123", version: "0.17.1-beta.11" },
      onDisk: { buildId: "def456", version: "0.17.1-beta.12" },
    });
    expect(stale).toContain("0.17.1-beta.11");
    expect(stale).toContain("0.17.1-beta.12");
    expect(stale).toMatch(/restart/i);

    expect(
      staleBinaryWarning({ stale: false, running: { buildId: "abc123", version: "1.0.0" }, onDisk: null }),
    ).toBeNull();
  });
});
