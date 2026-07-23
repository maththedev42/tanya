import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pointerDirForRepo, writeArchivePointers } from "../runArchivePointer";

describe("run-archive pointers (discoverability from touched repos)", () => {
  it("writes a <runId>.at pointer into each touched repo's .tanya/runs/", () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-ptr-ws-"));
    const repo = mkdtempSync(join(tmpdir(), "tanya-ptr-repo-"));
    const archiveDir = join(workspace, ".tanya", "runs");
    const archivePath = join(archiveDir, "r-abc.json");

    writeArchivePointers(archivePath, "r-abc", [repo], archiveDir);

    const pointer = join(pointerDirForRepo(repo), "r-abc.at");
    expect(existsSync(pointer)).toBe(true);
    expect(readFileSync(pointer, "utf8").trim()).toBe(archivePath);
  });

  it("does not write a self-pointer when the repo IS the archive root", () => {
    const repo = mkdtempSync(join(tmpdir(), "tanya-ptr-self-"));
    const archiveDir = join(repo, ".tanya", "runs");
    const archivePath = join(archiveDir, "r-xyz.json");

    writeArchivePointers(archivePath, "r-xyz", [repo], archiveDir);

    expect(existsSync(join(pointerDirForRepo(repo), "r-xyz.at"))).toBe(false);
  });

  it("is best-effort: an unwritable repo path never throws", () => {
    expect(() =>
      writeArchivePointers("/tmp/whatever/r.json", "r", ["/nonexistent/\0/repo"], "/tmp/other"),
    ).not.toThrow();
  });
});
