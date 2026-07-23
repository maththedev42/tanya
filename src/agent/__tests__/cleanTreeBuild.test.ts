import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanTreeTriggered, loadCleanTreeConfig, runCleanTreeBuild, upgradeToTestCompiling } from "../cleanTreeBuild";
import { buildFinalManifest } from "../report";
import { captureGitSnapshot } from "../git";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tanya-cleantree-t-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@e.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "seed.txt"), "x\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function head(dir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

// A portable stand-in for a compiler: fails (naming the file) when Manager.swift
// is absent from the checked-out tree — i.e. it was left untracked.
const BUILD_CMD = "test -f Manager.swift && echo BUILD_OK || { echo 'compile error: cannot find Manager.swift'; exit 1; }";

describe("loadCleanTreeConfig + cleanTreeTriggered", () => {
  it("loads config and matches the trigger glob", async () => {
    const dir = initRepo();
    mkdirSync(join(dir, ".tanya"), { recursive: true });
    writeFileSync(join(dir, ".tanya", "clean-tree-build.json"), JSON.stringify({ command: "swift build", trigger: "**/*.swift" }));
    const cfg = await loadCleanTreeConfig(dir);
    expect(cfg?.command).toBe("swift build");
    expect(cleanTreeTriggered(cfg!, ["Sources/View.swift"])).toBe(true);
    expect(cleanTreeTriggered(cfg!, ["README.md"])).toBe(false);
  });

  it("returns null when no config exists", async () => {
    expect(await loadCleanTreeConfig(initRepo())).toBeNull();
  });
});

describe("upgradeToTestCompiling (B/Task2 — compile test targets, don't run them)", () => {
  it("upgrades xcodebuild build -> build-for-testing", () => {
    expect(upgradeToTestCompiling("xcodebuild -scheme App build")).toBe("xcodebuild -scheme App build-for-testing");
    expect(upgradeToTestCompiling("xcodebuild build -scheme App")).toBe("xcodebuild build-for-testing -scheme App");
  });
  it("appends a compile-only test pass to go build", () => {
    expect(upgradeToTestCompiling("go build ./...")).toBe("go build ./... && go test -run '^$' -count=1 ./...");
  });
  it("leaves commands that already compile/run tests untouched", () => {
    expect(upgradeToTestCompiling("xcodebuild build-for-testing -scheme App")).toBe("xcodebuild build-for-testing -scheme App");
    expect(upgradeToTestCompiling("go test ./...")).toBe("go test ./...");
    expect(upgradeToTestCompiling("npm test")).toBe("npm test");
    expect(upgradeToTestCompiling("xcodebuild test -scheme App")).toBe("xcodebuild test -scheme App");
  });
  it("does not touch the word 'build' inside 'xcodebuild' itself", () => {
    // no standalone build action → nothing to upgrade
    expect(upgradeToTestCompiling("swift build")).toBe("swift build");
  });
});

describe("runCleanTreeBuild — test-target compilation (CosmoKit FIX3 shape)", () => {
  function goRepoWithBrokenTest(): string {
    const dir = mkdtempSync(join(tmpdir(), "tanya-cleantree-go-"));
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@e.com"]);
    git(dir, ["config", "user.name", "T"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(dir, "go.mod"), "module canary\n\ngo 1.20\n");
    // Library signature was CHANGED to take a second arg…
    writeFileSync(join(dir, "feature.go"), "package canary\n\nfunc New(name string, avail bool) int { if avail { return len(name) }; return 0 }\n");
    // …but the test target still uses the OLD 1-arg call (never updated).
    writeFileSync(join(dir, "feature_test.go"), "package canary\n\nimport \"testing\"\n\nfunc TestNew(t *testing.T) { _ = New(\"a\") }\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "signature change without updating the test call sites"]);
    return dir;
  }

  it("plain `go build ./...` PASSES (blind to the broken test), upgraded build FAILS", async () => {
    const dir = goRepoWithBrokenTest();
    const h = head(dir);
    // Opt out of the upgrade → plain build → honest but blind → passes.
    const plain = await runCleanTreeBuild(dir, h, { command: "go build ./...", compileTests: false });
    expect(plain.ran).toBe(true);
    expect(plain.ok).toBe(true);
    // Default (upgraded) → compiles the test target → catches the stale call site.
    const upgraded = await runCleanTreeBuild(dir, h, { command: "go build ./..." });
    expect(upgraded.ran).toBe(true);
    expect(upgraded.ok).toBe(false);
    expect(upgraded.output).toMatch(/New|not enough arguments|feature_test\.go/i);
  }, 120_000);
});

describe("runCleanTreeBuild", () => {
  it("fails when the committed tree omits a referenced file (F2 shape)", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "View.swift"), "let m = Manager.shared\n");
    writeFileSync(join(dir, "Manager.swift"), "enum Manager { static let shared = 1 }\n");
    git(dir, ["add", "View.swift"]); // Manager.swift left UNTRACKED
    git(dir, ["commit", "-q", "-m", "add view (references untracked manager)"]);

    const result = await runCleanTreeBuild(dir, head(dir), { command: BUILD_CMD });
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Manager.swift");
  });

  it("passes when the committed tree is complete", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "View.swift"), "let m = Manager.shared\n");
    writeFileSync(join(dir, "Manager.swift"), "enum Manager { static let shared = 1 }\n");
    git(dir, ["add", "View.swift", "Manager.swift"]);
    git(dir, ["commit", "-q", "-m", "add both"]);

    const result = await runCleanTreeBuild(dir, head(dir), { command: BUILD_CMD });
    expect(result.ok).toBe(true);
  });
});

describe("clean-tree gate in buildFinalManifest", () => {
  it("blocks and names the missing file when configured and a commit landed", async () => {
    const dir = initRepo();
    mkdirSync(join(dir, ".tanya"), { recursive: true });
    writeFileSync(join(dir, ".tanya", "clean-tree-build.json"), JSON.stringify({ command: BUILD_CMD, trigger: "**/*.swift" }));
    const before = await captureGitSnapshot(dir);
    // Commit View.swift; leave Manager.swift untracked (NOT in the write-log,
    // so only the clean-tree build can catch it).
    writeFileSync(join(dir, "View.swift"), "let m = Manager.shared\n");
    writeFileSync(join(dir, "Manager.swift"), "enum Manager { static let shared = 1 }\n");
    git(dir, ["add", "View.swift"]);
    git(dir, ["commit", "-q", "-m", "view only"]);

    const manifest = await buildFinalManifest({
      workspace: dir,
      beforeGitSnapshot: before,
      changed: ["View.swift"],
      verificationLines: [],
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      interactive: false,
    });

    expect(manifest.blockers.some((b) => /Clean-tree build FAILED/.test(b))).toBe(true);
    expect(manifest.blockers.some((b) => b.includes("Manager.swift"))).toBe(true);
  });

  it("is inert when no clean-tree config exists", async () => {
    const dir = initRepo();
    const before = await captureGitSnapshot(dir);
    writeFileSync(join(dir, "View.swift"), "let m = Manager.shared\n");
    git(dir, ["add", "View.swift"]);
    git(dir, ["commit", "-q", "-m", "view"]);
    const manifest = await buildFinalManifest({
      workspace: dir,
      beforeGitSnapshot: before,
      changed: ["View.swift"],
      verificationLines: [],
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      interactive: false,
    });
    expect(manifest.blockers.some((b) => /Clean-tree build/.test(b))).toBe(false);
  });
});
