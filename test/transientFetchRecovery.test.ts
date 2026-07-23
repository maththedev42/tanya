import { describe, expect, it } from "vitest";
import { failedVerificationBlockers } from "../src/agent/report";

const FETCH_FAIL =
  'Verification: curl -sfL "https://cosa-nostra-api.azurewebsites.net/openapi.json" -o /tmp/spec.json 2>&1 && python3 -c "import json" -> failed (Shell exited 56.)';

describe("transient network-fetch recovery", () => {
  it("recovers a failed curl when a later retry fetched the same resource", () => {
    const lines = [
      FETCH_FAIL,
      'Verification: curl -sfL --retry 2 --connect-timeout 15 "https://cosa-nostra-api.azurewebsites.net/openapi.json" -o /tmp/spec.json -> passed (Shell exited 0.)',
    ];
    expect(failedVerificationBlockers(lines)).toEqual([]);
  });

  it("recovers across a sibling path (same host + basename)", () => {
    const lines = [
      FETCH_FAIL,
      'Verification: curl -sfL "https://cosa-nostra-api.azurewebsites.net/api/openapi.json" -o /tmp/spec2.json -> passed (Shell exited 0.)',
    ];
    expect(failedVerificationBlockers(lines)).toEqual([]);
  });

  it("recovers a failed fetch when the authoritative build later passed", () => {
    const lines = [
      FETCH_FAIL,
      "Verification: ./gradlew assembleDebug --no-daemon 2>&1 -> passed (Shell exited 0.)",
    ];
    expect(failedVerificationBlockers(lines)).toEqual([]);
  });

  it("does NOT recover when neither the same resource was refetched nor the build passed", () => {
    const lines = [
      FETCH_FAIL,
      'Verification: curl -sfL "https://other-host.example.com/thing.json" -o /tmp/x.json -> passed (Shell exited 0.)',
    ];
    expect(failedVerificationBlockers(lines)).toHaveLength(1);
  });

  it("does not over-recover a non-fetch failure just because a build passed", () => {
    const lines = [
      "Verification: ./gradlew lintRelease --no-daemon -> failed (Shell exited 1.)",
      "Verification: ./gradlew assembleDebug --no-daemon -> passed (Shell exited 0.)",
    ];
    // lintRelease is not a network fetch and not otherwise recovered → stays a blocker.
    expect(failedVerificationBlockers(lines)).toHaveLength(1);
  });
});
