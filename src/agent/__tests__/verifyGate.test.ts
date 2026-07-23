import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bootSmokeCommands,
  commandVerified,
  loadBootSmokeConfig,
  parseVerifyCommands,
} from "../verifyGate";
import { buildFinalManifest } from "../report";
import { captureGitSnapshot } from "../git";

describe("parseVerifyCommands", () => {
  it("extracts real commands from the ## Verify section only", () => {
    const prompt = [
      "## Part 1 — do a thing",
      "Use `npm run build` here as part of the work.", // NOT in verify section
      "## Verify",
      "1. `npm test` green",
      "2. Run `cosmohq restart cosmohq` then check `psql \\d hosting`",
      "3. The report shows a coverage table", // prose, no command
      "4. `curl http://localhost:3003/healthz` returns 200",
      "## Commit",
      "5. `git push`", // NOT in verify section
    ].join("\n");
    const cmds = parseVerifyCommands(prompt);
    expect(cmds).toContain("npm test");
    expect(cmds).toContain("cosmohq restart cosmohq");
    expect(cmds).toContain("psql \\d hosting");
    expect(cmds).toContain("curl http://localhost:3003/healthz");
    expect(cmds).not.toContain("npm run build");
    expect(cmds).not.toContain("git push");
  });

  it("ignores code snippets that are not commands", () => {
    const prompt = "## Verify\n- `L10n.tr(\"Get Set Up\")` renders\n- `exitCode == 146`\n- `foo.bar()`";
    expect(parseVerifyCommands(prompt)).toEqual([]);
  });

  it("returns nothing without a verify section", () => {
    expect(parseVerifyCommands("Just fix the bug. `npm test` passes.")).toEqual([]);
  });
});

describe("commandVerified", () => {
  const lines = [
    "Verification: npm test -> passed",
    "Verification: go build ./... -> passed",
  ];
  it("recognises a command that ran and passed", () => {
    expect(commandVerified("npm test", lines)).toBe(true);
  });
  it("rejects a command with no evidence", () => {
    expect(commandVerified("cosmohq restart cosmohq", lines)).toBe(false);
  });
  it("rejects a command whose only line failed", () => {
    expect(commandVerified("npm test", ["Verification: npm test -> failed"])).toBe(false);
  });
});

describe("boot-smoke config", () => {
  it("loads checks and triggers them on matching changed files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tanya-bootsmoke-"));
    mkdirSync(join(dir, ".tanya"), { recursive: true });
    writeFileSync(
      join(dir, ".tanya", "boot-smoke.json"),
      JSON.stringify({ checks: [{ trigger: "**/migrations/*.sql", command: "cosmohq restart cosmohq", healthCheck: "http://localhost:3003/healthz" }] }),
    );
    const checks = await loadBootSmokeConfig(dir);
    expect(checks).toHaveLength(1);
    expect(bootSmokeCommands(checks, ["api/db/migrations/91050_x.sql"])).toEqual(["cosmohq restart cosmohq"]);
    expect(bootSmokeCommands(checks, ["api/handler.go"])).toEqual([]);
  });

  it("is empty when no config file exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tanya-bootsmoke-none-"));
    expect(await loadBootSmokeConfig(dir)).toEqual([]);
  });
});

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tanya-verifygate-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

const VERIFY_PROMPT = "## Part 1 — thing\n## Verify\n1. `cosmohq restart cosmohq`\n2. `psql \\d hosting`";

describe("verify-gate in buildFinalManifest", () => {
  it("blocks when a required verify command has no passing evidence", async () => {
    const dir = tempRepo();
    const before = await captureGitSnapshot(dir);
    const manifest = await buildFinalManifest({
      workspace: dir,
      beforeGitSnapshot: before,
      changed: [],
      verificationLines: [], // nothing was verified
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      prompt: VERIFY_PROMPT,
      interactive: false,
    });
    expect(manifest.blockers.some((b) => /Verify step\(s\) not executed/.test(b))).toBe(true);
    expect(manifest.blockers.some((b) => b.includes("cosmohq restart cosmohq"))).toBe(true);
  });

  it("passes when every required verify command has passing evidence", async () => {
    const dir = tempRepo();
    const before = await captureGitSnapshot(dir);
    const manifest = await buildFinalManifest({
      workspace: dir,
      beforeGitSnapshot: before,
      changed: [],
      verificationLines: [
        "Verification: cosmohq restart cosmohq -> passed",
        "Verification: psql \\d hosting -> passed",
      ],
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      prompt: VERIFY_PROMPT,
      interactive: false,
    });
    expect(manifest.blockers.some((b) => /Verify step\(s\) not executed/.test(b))).toBe(false);
  });

  it("E8: FIRES for an interactive TASK run whose ## Verify command went unrun (mac-app hole)", async () => {
    const dir = tempRepo();
    const before = await captureGitSnapshot(dir);
    // FIX2-01 shape: a Verification Contract with an xcodebuild step, run interactively.
    const manifest = await buildFinalManifest({
      workspace: dir,
      beforeGitSnapshot: before,
      changed: [],
      verificationLines: [], // xcodebuild never run
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      prompt: "## Verification Contract\n1. `xcodebuild build` succeeds\n2. `xcodebuild test` green",
      interactive: true,
    });
    expect(manifest.blockers.some((b) => /Verify step\(s\) not executed/.test(b))).toBe(true);
    expect(manifest.blockers.some((b) => b.includes("xcodebuild build"))).toBe(true);
  });

  it("does NOT fire for a bare interactive chat turn (no verify section, no task shape)", async () => {
    const dir = tempRepo();
    const before = await captureGitSnapshot(dir);
    const manifest = await buildFinalManifest({
      workspace: dir,
      beforeGitSnapshot: before,
      changed: [],
      verificationLines: [],
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      prompt: "how does the auth flow work?",
      interactive: true,
    });
    expect(manifest.blockers.some((b) => /Verify step\(s\) not executed/.test(b))).toBe(false);
  });
});
