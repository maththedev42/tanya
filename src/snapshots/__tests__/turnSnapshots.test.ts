import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listSnapshots,
  owningRoot,
  restoreSnapshot,
  snapshotForPaths,
  takeSnapshot,
  undoToPreviousSnapshot,
} from "../turnSnapshots";

let workspace: string;
let store: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "tanya-snap-ws-"));
  store = mkdtempSync(join(tmpdir(), "tanya-snap-store-"));
  vi.stubEnv("TANYA_SNAPSHOTS_DIR", store);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
});

describe("turnSnapshots", () => {
  it("snapshots a plain (non-git) directory and lists newest-first, with marker commits on unchanged trees", () => {
    writeFileSync(join(workspace, "a.txt"), "one\n");
    const first = takeSnapshot(workspace, "pre-turn:1");
    expect(first).not.toBeNull();
    const second = takeSnapshot(workspace, "pre-turn:2");
    expect(second).not.toBeNull();
    // The user's directory got no .git of its own.
    expect(existsSync(join(workspace, ".git"))).toBe(false);
    const listed = listSnapshots(workspace);
    expect(listed.length).toBe(2);
    expect(listed[0]!.label).toBe("pre-turn:2");
    expect(listed[1]!.label).toBe("pre-turn:1");
    // Marker commits: same tree, distinct snapshots.
    expect(listed[0]!.sha).not.toBe(listed[1]!.sha);
  });

  it("restore returns edited content and deletes files absent in the target", () => {
    writeFileSync(join(workspace, "a.txt"), "original\n");
    const snap = takeSnapshot(workspace, "pre-turn:1");
    expect(snap).not.toBeNull();
    writeFileSync(join(workspace, "a.txt"), "clobbered\n");
    writeFileSync(join(workspace, "extra.txt"), "should be deleted\n");
    expect(restoreSnapshot(workspace, snap!.id)).toBe(true);
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("original\n");
    expect(existsSync(join(workspace, "extra.txt"))).toBe(false);
  });

  it("undo restores the newest snapshot whose tree differs (walking past no-ops)", () => {
    writeFileSync(join(workspace, "a.txt"), "v1\n");
    takeSnapshot(workspace, "pre-turn:1");
    writeFileSync(join(workspace, "a.txt"), "v2\n");
    takeSnapshot(workspace, "pre-turn:2"); // same tree as current worktree
    const undone = undoToPreviousSnapshot(workspace);
    expect(undone?.label).toBe("pre-turn:1");
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("v1\n");
  });

  it("returns null from undo when nothing differs", () => {
    writeFileSync(join(workspace, "a.txt"), "same\n");
    takeSnapshot(workspace, "pre-turn:1");
    expect(undoToPreviousSnapshot(workspace)).toBeNull();
  });

  it("respects .gitignore and never deletes ignored files on restore", () => {
    writeFileSync(join(workspace, ".gitignore"), "secret.env\n");
    writeFileSync(join(workspace, "a.txt"), "v1\n");
    const snap = takeSnapshot(workspace, "pre-turn:1");
    writeFileSync(join(workspace, "secret.env"), "TOKEN=x\n");
    writeFileSync(join(workspace, "a.txt"), "v2\n");
    expect(restoreSnapshot(workspace, snap!.id)).toBe(true);
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("v1\n");
    // Ignored file untouched: not snapshotted, not deleted.
    expect(readFileSync(join(workspace, "secret.env"), "utf8")).toBe("TOKEN=x\n");
  });

  it("keys snapshots on the owning nested repo, not the multi-repo workspace root", () => {
    const nested = join(workspace, "project");
    mkdirSync(nested);
    execFileSync("git", ["init", "-q"], { cwd: nested });
    writeFileSync(join(nested, "code.ts"), "v1\n");
    expect(realpathSync(owningRoot(workspace, "project/code.ts"))).toBe(realpathSync(nested));
    const records = snapshotForPaths(workspace, ["project/code.ts"], "pre-turn:1");
    expect(records.length).toBe(1);
    // The snapshot lists under the NESTED root, and captures its file content.
    expect(listSnapshots(nested).length).toBe(1);
    expect(listSnapshots(workspace).length).toBe(0);
    writeFileSync(join(nested, "code.ts"), "v2\n");
    expect(restoreSnapshot(nested, records[0]!.id)).toBe(true);
    expect(readFileSync(join(nested, "code.ts"), "utf8")).toBe("v1\n");
    // The nested repo's own .git was never used for the snapshot commits.
    const commitCount = execFileSync("git", ["rev-list", "--all", "--count"], { cwd: nested, encoding: "utf8" }).trim();
    expect(commitCount).toBe("0");
  });

  it("read-only queries on a never-snapshotted directory create no store", () => {
    writeFileSync(join(workspace, "a.txt"), "content\n");
    expect(listSnapshots(workspace)).toEqual([]);
    expect(undoToPreviousSnapshot(workspace)).toBeNull();
    expect(restoreSnapshot(workspace, "s1-anything")).toBe(false);
    // No side repo materialized — and no `add -A` copied the tree's blobs
    // into an object store just to answer "nothing here".
    expect(readdirSync(store)).toEqual([]);
  });

  it("caps the snapshot list at 50", () => {
    writeFileSync(join(workspace, "a.txt"), "x\n");
    for (let index = 0; index < 55; index += 1) {
      writeFileSync(join(workspace, "a.txt"), `content ${index}\n`);
      expect(takeSnapshot(workspace, `pre-turn:${index}`)).not.toBeNull();
    }
    expect(listSnapshots(workspace).length).toBeLessThanOrEqual(50);
  }, 60_000);
});
