import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { outsideWorkspaceShellMutationError } from "../src/tools/fsTools";

// Mimic macOS, where $TMPDIR is /var/folders/... (a symlink) but the real path
// is /private/var/folders/.... The workspace is stored as the symlink form;
// an isolated-worktree step cd's via the resolved/real path.
const realRoot = realpathSync(mkdtempSync(join(tmpdir(), "ws-real-")));
const linkRoot = mkdtempSync(join(tmpdir(), "ws-link-"));
const workspaceReal = join(realRoot, "worktree");
mkdirSync(workspaceReal);
const workspaceSymlink = join(linkRoot, "worktree"); // symlink → realpath form
symlinkSync(workspaceReal, workspaceSymlink);

afterAll(() => {
  rmSync(realRoot, { recursive: true, force: true });
  rmSync(linkRoot, { recursive: true, force: true });
});

describe("outsideWorkspaceShellMutationError symlink canonicalization", () => {
  it("does NOT reject an in-workspace mutation when workspace is the symlink form and cd uses the real path", () => {
    const script = `cd ${workspaceReal} && echo '# Xcode' >> .gitignore`;
    expect(outsideWorkspaceShellMutationError(script, workspaceSymlink, workspaceSymlink)).toBeNull();
  });

  it("does NOT reject when both sides are the symlink form", () => {
    const script = `cd ${workspaceSymlink} && echo '# Xcode' >> .gitignore`;
    expect(outsideWorkspaceShellMutationError(script, workspaceSymlink, workspaceSymlink)).toBeNull();
  });

  it("STILL rejects a genuinely outside-workspace mutation", () => {
    const outside = realpathSync(tmpdir());
    const script = `cd ${outside} && rm -rf something`;
    expect(outsideWorkspaceShellMutationError(script, workspaceSymlink, workspaceSymlink)).not.toBeNull();
  });
});
