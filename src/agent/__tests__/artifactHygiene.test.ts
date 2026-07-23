import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureGitSnapshot, strayArtifactsSince } from "../git";
import { buildFinalManifest } from "../report";

// Artifact hygiene (PROMPT B item 5). The audited failure left a stray
// `fastlane/` scaffold from an aborted init in the source tree — created by a
// subprocess, so it never entered the mutation write-log and the commit gate
// could not see it.

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tanya-hygiene-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@e.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "a.ts"), "export {};\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

describe("strayArtifactsSince", () => {
  it("flags files that appeared during the run and belong to no deliverable", async () => {
    const dir = initRepo();
    const before = await captureGitSnapshot(dir);
    mkdirSync(join(dir, "fastlane"));
    writeFileSync(join(dir, "fastlane", "Fastfile"), "lane :noop do\nend\n");
    const after = await captureGitSnapshot(dir);
    expect(strayArtifactsSince(before, after, ["a.ts"])).toEqual(["fastlane/Fastfile"]);
  });

  it("attributed paths and files under attributed directories are not strays", async () => {
    const dir = initRepo();
    const before = await captureGitSnapshot(dir);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "new.ts"), "export {};\n");
    const after = await captureGitSnapshot(dir);
    expect(strayArtifactsSince(before, after, ["src/new.ts"])).toEqual([]);
    expect(strayArtifactsSince(before, after, ["src"])).toEqual([]);
  });

  it("pre-existing dirt is never a stray (it did not appear this run)", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "leftover.tmp2"), "old\n");
    const before = await captureGitSnapshot(dir);
    const after = await captureGitSnapshot(dir);
    expect(strayArtifactsSince(before, after, [])).toEqual([]);
  });
});

describe("hygiene nudge through buildFinalManifest", () => {
  it("nudges (never blocks) on a subprocess scaffold outside the write-log", async () => {
    const dir = initRepo();
    const before = await captureGitSnapshot(dir);
    // The session writes a.ts (attributed) and commits it; a subprocess drops
    // a fastlane scaffold that no one declared.
    writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
    git(dir, ["add", "a.ts"]);
    git(dir, ["commit", "-q", "-m", "work"]);
    mkdirSync(join(dir, "fastlane"));
    writeFileSync(join(dir, "fastlane", "Fastfile"), "lane :noop do\nend\n");

    const manifest = await buildFinalManifest({
      workspace: dir,
      beforeGitSnapshot: before,
      changed: ["a.ts"],
      verificationLines: [],
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      prompt: "Do the work and commit it.",
    });

    const nudge = manifest.reportNudges?.find((note) => note.startsWith("stray artifacts:"));
    expect(nudge).toBeTruthy();
    expect(nudge).toContain("fastlane/Fastfile");
    expect(manifest.gates?.artifactHygiene?.strays).toContain("fastlane/Fastfile");
    // Nudge only: no hygiene blocker may exist.
    expect(manifest.blockers.some((blocker) => blocker.includes("stray artifacts"))).toBe(false);
  }, 30_000);
});
