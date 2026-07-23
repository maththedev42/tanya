import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ValidationManifest } from "../core";
import {
  constantFieldValidator,
  deadEnumCaseValidator,
  deadGoExportValidator,
  deletedAnalyticsValidator,
  emptyConditionalStubValidator,
  externalFactValidator,
  noOpHandlerValidator,
} from "../reachabilityChecks";
import { validateCodingTask } from "../index";

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tanya-reach-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

const manifest = (changedFiles: string[]): ValidationManifest => ({ changedFiles });

describe("externalFactValidator (G5/F6 — invented external facts)", () => {
  it("flags a hardcoded non-zero exit code with no verification/ASSUMPTION", async () => {
    const ws = workspace({ "boot.ts": "if (result.exitCode == 146) { return 'already booted'; }\n" });
    const issues = await externalFactValidator.run(ws, manifest(["boot.ts"]));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.id).toBe("task-external-fact-unverified");
    expect(issues[0]?.severity).toBe("warning");
  });

  it("does not flag when an ASSUMPTION marker is present in the file", async () => {
    const ws = workspace({ "boot.ts": "// ASSUMPTION: 146 = already booted, matched broadly below\nif (result.exitCode == 146) {}\n" });
    expect(await externalFactValidator.run(ws, manifest(["boot.ts"]))).toEqual([]);
  });

  it("ignores a benign zero exit code", async () => {
    const ws = workspace({ "boot.ts": "if (code == 0) {}\n" });
    expect(await externalFactValidator.run(ws, manifest(["boot.ts"]))).toEqual([]);
  });
});

describe("deadEnumCaseValidator (G4 — declared but never emitted)", () => {
  it("flags an enum case referenced nowhere else", async () => {
    const ws = workspace({
      "Model.swift": "enum Hosting {\n  case azure\n  case neon\n  case unusedGhost\n}\n",
      "Use.swift": "let x: Hosting = .azure\nlet y: Hosting = .neon\n",
    });
    const issues = await deadEnumCaseValidator.run(ws, manifest(["Model.swift"]));
    expect(issues.some((i) => i.message.includes("unusedGhost"))).toBe(true);
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
    // azure/neon are referenced → not flagged
    expect(issues.some((i) => i.message.includes("azure"))).toBe(false);
  });

  it("does not flag when every case is referenced", async () => {
    const ws = workspace({
      "Model.swift": "enum Mode {\n  case on\n  case off\n}\n",
      "Use.swift": "let a: Mode = .on\nlet b: Mode = .off\n",
    });
    expect(await deadEnumCaseValidator.run(ws, manifest(["Model.swift"]))).toEqual([]);
  });
});

describe("noOpHandlerValidator (F5 — dead-looking-alive)", () => {
  it("flags activateFileViewerSelecting([])", async () => {
    const ws = workspace({ "Reveal.swift": "func reveal() { NSWorkspace.shared.activateFileViewerSelecting([]) }\n" });
    const issues = await noOpHandlerValidator.run(ws, manifest(["Reveal.swift"]));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("warning");
  });
});

describe("deadGoExportValidator (F3 — dead code written and called done)", () => {
  function goRepo(files: Record<string, string>): string {
    const dir = workspace(files);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
    return dir;
  }

  it("flags an exported symbol in a new file referenced nowhere", async () => {
    const dir = goRepo({
      "resolver.go": "package builds\n\nfunc ResolveBackendTarget() string { return \"x\" }\n", // untracked/new, unused
    });
    const issues = await deadGoExportValidator.run(dir, manifest(["resolver.go"]));
    expect(issues.some((i) => i.message.includes("ResolveBackendTarget"))).toBe(true);
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
  });

  it("does not flag an exported symbol that is used elsewhere", async () => {
    const dir = goRepo({
      "resolver.go": "package builds\n\nfunc ResolveBackendTarget() string { return \"x\" }\n",
      "handler.go": "package builds\n\nfunc use() string { return ResolveBackendTarget() }\n",
    });
    expect(await deadGoExportValidator.run(dir, manifest(["resolver.go"]))).toEqual([]);
  });
});

describe("emptyConditionalStubValidator (E4 — empty-if stub for a specced event)", () => {
  it("flags a conditional whose body is only a comment", async () => {
    const ws = workspace({ "Track.swift": "func onXcode() {\n  if isFirstRun {\n    // TODO: track xcode_opened here\n  }\n}\n" });
    const issues = await emptyConditionalStubValidator.run(ws, manifest(["Track.swift"]));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.id).toBe("task-empty-conditional-stub");
    expect(issues[0]?.severity).toBe("warning");
  });

  it("does not flag a conditional with a real body", async () => {
    const ws = workspace({ "Track.swift": "if isFirstRun {\n  Observability.track(\"xcode_opened\")\n}\n" });
    expect(await emptyConditionalStubValidator.run(ws, manifest(["Track.swift"]))).toEqual([]);
  });
});

describe("constantFieldValidator (E4 — constant-default field makes a filter dead)", () => {
  it("flags a bool field defaulting true, never assigned, that a filter depends on", async () => {
    const ws = workspace({
      "Device.swift": "struct SimulatorDevice {\n  let name: String\n  var isAvailable = true\n}\n",
      "Service.swift": "let usable = devices.filter { $0.isAvailable }\n",
    });
    const issues = await constantFieldValidator.run(ws, manifest(["Device.swift"]));
    expect(issues.some((i) => i.message.includes("isAvailable"))).toBe(true);
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
  });

  it("does not flag when the field is actually assigned from parsed data", async () => {
    const ws = workspace({
      "Device.swift": "struct SimulatorDevice {\n  var isAvailable = true\n}\n",
      "Parse.swift": "let d = SimulatorDevice(isAvailable: parsedAvailability)\nlet u = list.filter { $0.isAvailable }\n",
    });
    expect(await constantFieldValidator.run(ws, manifest(["Device.swift"]))).toEqual([]);
  });

  it("does not flag a typed constant field whose only branch is absent", async () => {
    const ws = workspace({ "Device.swift": "struct D {\n  var isReady: Bool = false\n}\n" });
    expect(await constantFieldValidator.run(ws, manifest(["Device.swift"]))).toEqual([]);
  });
});

describe("deletedAnalyticsValidator (E4 — a track call dropped in a rewrite)", () => {
  function gitRepo(files: Record<string, string>): string {
    const dir = workspace(files);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    return dir;
  }

  it("flags an analytics emit present before a rewrite and absent after", async () => {
    const dir = gitRepo({
      "Onboarding.swift": "func dismiss() {\n  Observability.track(\"onboarding_dismissed\")\n  close()\n}\n",
    });
    // Rewrite drops the track call.
    writeFileSync(join(dir, "Onboarding.swift"), "func dismiss() {\n  close()\n}\n");
    const issues = await deletedAnalyticsValidator.run(dir, manifest(["Onboarding.swift"]));
    expect(issues.some((i) => i.message.includes("onboarding_dismissed"))).toBe(true);
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
  });

  it("does not flag when the event is preserved (or renamed and re-added)", async () => {
    const dir = gitRepo({
      "Onboarding.swift": "func dismiss() {\n  Observability.track(\"onboarding_dismissed\")\n}\n",
    });
    writeFileSync(join(dir, "Onboarding.swift"), "func dismiss() {\n  Observability.track(\"onboarding_dismissed\")\n  extra()\n}\n");
    expect(await deletedAnalyticsValidator.run(dir, manifest(["Onboarding.swift"]))).toEqual([]);
  });
});

describe("nudge-tier invariant — warnings never fail the run", () => {
  it("validateCodingTask stays passed=true with only reachability warnings", async () => {
    const ws = workspace({ "boot.ts": "if (result.exitCode == 146) {}\n" });
    // Disarm the (unrelated) commit validator so this isolates the nudge tier:
    // the reachability warning must not, by itself, flip passed to false.
    const runContext = { metadata: { requireCommit: false } } as unknown as Parameters<typeof validateCodingTask>[2];
    const summary = await validateCodingTask(ws, manifest(["boot.ts"]), runContext);
    expect(summary.passed).toBe(true);
    expect(summary.issues.some((i) => i.id === "task-external-fact-unverified")).toBe(true);
  });
});
