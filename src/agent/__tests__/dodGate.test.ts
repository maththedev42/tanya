import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  behavioralCriteria,
  readLatestRuntimeVerdict,
  requiresRuntimeVerification,
  runtimeDodAssessment,
} from "../dodGate";

const tmpDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tanya-dod-"));
  tmpDirs.push(dir);
  return dir;
}

async function writeVerdict(
  workspace: string,
  runId: string,
  verdict: Record<string, unknown>,
  mtimeMs: number,
): Promise<void> {
  const dir = join(workspace, ".tanya", "runtime", runId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "verdict.json");
  await writeFile(path, JSON.stringify(verdict));
  const seconds = mtimeMs / 1000;
  await utimes(path, seconds, seconds);
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("behavioralCriteria / requiresRuntimeVerification", () => {
  it("flags app/UI behaviour for a calculator", () => {
    expect(behavioralCriteria("build an iOS calculator app").map((c) => c.id)).toContain("digits-render");
    expect(requiresRuntimeVerification("build an iOS calculator app", true)).toBe(true);
  });

  it("does not require runtime verification for a non-behavioural chore", () => {
    expect(behavioralCriteria("fix a typo in the README")).toHaveLength(0);
    expect(requiresRuntimeVerification("fix a typo in the README", true)).toBe(false);
  });

  it("never requires verification for a non-coding task", () => {
    expect(requiresRuntimeVerification("build an iOS calculator app", false)).toBe(false);
  });

  it("can be disabled via TANYA_DOD_GATE", () => {
    const prev = process.env.TANYA_DOD_GATE;
    process.env.TANYA_DOD_GATE = "0";
    try {
      expect(requiresRuntimeVerification("build an iOS calculator app", true)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.TANYA_DOD_GATE;
      else process.env.TANYA_DOD_GATE = prev;
    }
  });
});

describe("readLatestRuntimeVerdict", () => {
  it("returns null when no runtime evidence exists", async () => {
    const ws = await makeWorkspace();
    expect(await readLatestRuntimeVerdict(ws, 0)).toBeNull();
  });

  it("ignores verdicts older than the run start (no stale clear)", async () => {
    const ws = await makeWorkspace();
    await writeVerdict(ws, "old", { status: "pass", reason: "ok" }, 1000);
    expect(await readLatestRuntimeVerdict(ws, 5000)).toBeNull();
  });

  it("picks the freshest verdict and maps skipped -> skip", async () => {
    const ws = await makeWorkspace();
    await writeVerdict(ws, "a", { status: "fail", reason: "old fail" }, 2000);
    await writeVerdict(ws, "b", { status: "skipped", reason: "no simulator" }, 4000);
    expect(await readLatestRuntimeVerdict(ws, 1000)).toEqual({ status: "skip", reason: "no simulator" });
  });

  it("fails open on malformed verdict json", async () => {
    const ws = await makeWorkspace();
    const dir = join(ws, ".tanya", "runtime", "bad");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "verdict.json"), "{not json");
    expect(await readLatestRuntimeVerdict(ws, 0)).toBeNull();
  });
});

describe("runtimeDodAssessment", () => {
  const calc = "build an iOS calculator app";

  it("nudges (unverified) when behaviour was never exercised", async () => {
    const ws = await makeWorkspace();
    const result = await runtimeDodAssessment({ prompt: calc, isCoding: true, workspace: ws, sinceMs: 0 });
    expect(result.blockers).toHaveLength(0);
    expect(result.unverified).toBe(true);
    expect(result.unverifiedReason).toBeTruthy();
  });

  it("clears on a passing runtime verdict", async () => {
    const ws = await makeWorkspace();
    await writeVerdict(ws, "run", { status: "pass", reason: "all behaviours ok" }, 10_000);
    expect(await runtimeDodAssessment({ prompt: calc, isCoding: true, workspace: ws, sinceMs: 1000 }))
      .toEqual({ blockers: [], unverified: false });
  });

  it("clears on a skipped runtime verdict (host cannot run the app)", async () => {
    const ws = await makeWorkspace();
    await writeVerdict(ws, "run", { status: "skipped", reason: "no simulator" }, 10_000);
    expect(await runtimeDodAssessment({ prompt: calc, isCoding: true, workspace: ws, sinceMs: 1000 }))
      .toEqual({ blockers: [], unverified: false });
  });

  it("gates with a blocker on a real runtime failure", async () => {
    const ws = await makeWorkspace();
    await writeVerdict(ws, "run", { status: "fail", reason: "2 + 2 showed 22" }, 10_000);
    const result = await runtimeDodAssessment({ prompt: calc, isCoding: true, workspace: ws, sinceMs: 1000 });
    expect(result.unverified).toBe(false);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]).toMatch(/^behavior failed:/);
    expect(result.blockers[0]).toContain("2 + 2 showed 22");
  });

  it("stays silent for non-behavioural tasks even with no evidence", async () => {
    const ws = await makeWorkspace();
    expect(await runtimeDodAssessment({ prompt: "fix a typo", isCoding: true, workspace: ws, sinceMs: 0 }))
      .toEqual({ blockers: [], unverified: false });
  });
});
