import { describe, expect, it } from "vitest";
import { buildDriftNudge, buildDriftWrapUpDirective, buildWrapUpDirective, DRIFT_FIRST_NUDGE_TURN, DRIFT_SECOND_NUDGE_TURN, DRIFT_WRAP_UP_TURN, readOnlyDriftAction, resolveProgressBudget, shouldStopAfterBudget, wrapUpExpired, WRAP_UP_TURNS } from "../progressBudget";

describe("resolveProgressBudget", () => {
  it("is disabled (exact cap) unless the caller opts in", () => {
    // eval harness / sub-agents / explicit --max-turns pass no extendOnProgress
    expect(resolveProgressBudget(40).enabled).toBe(false);
    expect(resolveProgressBudget(40).hardCeiling).toBe(40); // exact cap preserved
    expect(resolveProgressBudget(300).hardCeiling).toBe(300);
  });

  it("is UNBOUNDED when opted in with no explicit ceiling — long tasks never fail on a step count", () => {
    expect(resolveProgressBudget(40, { extendOnProgress: true }).enabled).toBe(true);
    expect(resolveProgressBudget(40, { extendOnProgress: true }).hardCeiling).toBe(Number.POSITIVE_INFINITY);
    expect(resolveProgressBudget(100, { extendOnProgress: true }).hardCeiling).toBe(Number.POSITIVE_INFINITY);
  });

  it("honours an explicit ceiling (TANYA_HARD_TURN_CEILING) when opted in", () => {
    expect(resolveProgressBudget(40, { extendOnProgress: true, ceiling: 300 }).hardCeiling).toBe(300);
    // a soft budget already above the ceiling keeps its own value
    expect(resolveProgressBudget(500, { extendOnProgress: true, ceiling: 300 }).hardCeiling).toBe(500);
    // nonsense ceilings fall back to unbounded
    expect(resolveProgressBudget(40, { extendOnProgress: true, ceiling: 0 }).hardCeiling).toBe(Number.POSITIVE_INFINITY);
    expect(resolveProgressBudget(40, { extendOnProgress: true, ceiling: Number.NaN }).hardCeiling).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("shouldStopAfterBudget", () => {
  const off = resolveProgressBudget(100); // not opted in
  const on = resolveProgressBudget(100, { extendOnProgress: true });

  it("never stops when extension is disabled (loop bound enforces the cap)", () => {
    expect(shouldStopAfterBudget(99, 100, 0, off)).toBe(false);
    expect(shouldStopAfterBudget(150, 100, 0, off)).toBe(false);
  });

  it("never early-stops WITHIN the soft budget, even with no progress (cold start safe)", () => {
    // turn 8, no progress since turn 0 -> within budget -> must NOT stop
    expect(shouldStopAfterBudget(8, 100, 0, on)).toBe(false);
    expect(shouldStopAfterBudget(99, 100, 0, on)).toBe(false);
  });

  it("keeps a productive run going past the soft budget", () => {
    // turn 150, last progress on turn 149 -> turnsSinceProgress === 1 (healthy)
    expect(shouldStopAfterBudget(150, 100, 149, on)).toBe(false);
  });

  it("stops past the soft budget once the previous turn made no progress", () => {
    // turn 150, last progress on turn 148 -> turnsSinceProgress === 2
    expect(shouldStopAfterBudget(150, 100, 148, on)).toBe(true);
  });
});

describe("wrap-up window (beta.32 — no more silent budget death)", () => {
  it("wrapUpExpired: null state never expires", () => {
    expect(wrapUpExpired(null, 500)).toBe(false);
  });

  it("wrapUpExpired: false within the window, true at the deadline", () => {
    const state = { startedTurn: 10, reason: "no_progress" as const };
    expect(wrapUpExpired(state, 10)).toBe(false);
    expect(wrapUpExpired(state, 10 + WRAP_UP_TURNS - 1)).toBe(false);
    expect(wrapUpExpired(state, 10 + WRAP_UP_TURNS)).toBe(true);
    expect(wrapUpExpired(state, 10 + WRAP_UP_TURNS + 3)).toBe(true);
  });

  it("deadline is hard: progress during wrap-up must not matter to expiry", () => {
    // wrapUpExpired takes no progress input at all — that is the guarantee.
    const state = { startedTurn: 0, reason: "stall_tokens" as const };
    expect(wrapUpExpired(state, WRAP_UP_TURNS)).toBe(true);
  });

  it("directive orders commit-first then final report, and forbids new work", () => {
    for (const reason of ["stall_tokens", "no_progress"] as const) {
      const directive = buildWrapUpDirective(reason);
      expect(directive).toContain("BUDGET WALL");
      expect(directive).toContain("Do NOT start new work");
      const commitIdx = directive.indexOf("COMMIT them path-limited");
      const reportIdx = directive.indexOf("FINAL coding report");
      expect(commitIdx).toBeGreaterThan(-1);
      expect(reportIdx).toBeGreaterThan(commitIdx);
    }
  });

  it("directive names the actual window size", () => {
    expect(buildWrapUpDirective("no_progress")).toContain(String(WRAP_UP_TURNS));
  });
});

describe("read-only drift guard (beta.34 — implement, don't just research)", () => {
  it("fires nothing when disarmed or after the first mutation", () => {
    expect(readOnlyDriftAction(DRIFT_FIRST_NUDGE_TURN, false, false)).toBeNull();
    expect(readOnlyDriftAction(DRIFT_FIRST_NUDGE_TURN, true, true)).toBeNull();
    expect(readOnlyDriftAction(DRIFT_WRAP_UP_TURN, true, true)).toBeNull();
  });

  it("escalates: nudge at 8, final warning at 16, wrap-up at 24 — each exactly once", () => {
    const actions = Array.from({ length: 30 }, (_, turn) => readOnlyDriftAction(turn, false, true));
    expect(actions[DRIFT_FIRST_NUDGE_TURN]).toBe("nudge");
    expect(actions[DRIFT_SECOND_NUDGE_TURN]).toBe("final_nudge");
    expect(actions[DRIFT_WRAP_UP_TURN]).toBe("wrap_up");
    expect(actions.filter(Boolean)).toHaveLength(3);
  });

  it("nudges demand an edit or an explicit NEEDS USER, never more reading", () => {
    expect(buildDriftNudge("nudge")).toContain("FIRST real edit");
    expect(buildDriftNudge("nudge")).toContain("NEEDS USER");
    expect(buildDriftNudge("final_nudge")).toContain("Start implementing NOW");
  });

  it("drift wrap-up demands the honest report shape", () => {
    const directive = buildDriftWrapUpDirective();
    expect(directive).toContain("FINAL report");
    expect(directive).toContain("Why no edit was made");
  });
});
