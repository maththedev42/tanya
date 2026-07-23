import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../registry";

// Functional coverage for the core file/command tools, driven through
// ToolRegistry.run (so the write gate sits in the path, exactly like a real
// run). Each test uses a throwaway workspace; nothing touches the repo.

const registry = new ToolRegistry();
let workspace: string;

function run(name: string, input: unknown) {
  const tool = registry.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return registry.run(tool, input, { workspace });
}

const hasRg = registry.get("search") !== undefined;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "tanya-tools-fn-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("core tools — functional", () => {
  it("write_file creates nested files and reports them; read_file round-trips", async () => {
    const written = await run("write_file", { path: "src/deep/app.txt", content: "line one\nline two\n" });
    expect(written.ok).toBe(true);
    expect(written.files).toEqual(["src/deep/app.txt"]);
    expect(readFileSync(join(workspace, "src/deep/app.txt"), "utf8")).toBe("line one\nline two\n");
    const read = await run("read_file", { path: "src/deep/app.txt" });
    expect(read.ok).toBe(true);
    expect(read.output).toBe("line one\nline two\n");
  });

  it("read_file on a missing path rejects (the runner converts throws to error results)", async () => {
    await expect(run("read_file", { path: "nope/missing.txt" })).rejects.toThrow();
  });

  it("write_file refuses paths escaping the workspace", async () => {
    await expect(run("write_file", { path: "../escape.txt", content: "x" })).rejects.toThrow();
    expect(existsSync(join(workspace, "..", "escape.txt"))).toBe(false);
  });

  it("list_files sees workspace files but skips dependency directories", async () => {
    writeFileSync(join(workspace, "index.ts"), "export {};\n");
    mkdirSync(join(workspace, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(workspace, "node_modules/pkg/dep.js"), "x\n");
    const result = await run("list_files", {});
    expect(result.ok).toBe(true);
    const files = result.output as string[];
    expect(files).toContain("index.ts");
    expect(files.some((file) => file.includes("node_modules"))).toBe(false);
  });

  it("apply_patch applies a unified diff to an existing file", async () => {
    writeFileSync(join(workspace, "app.txt"), "hello world\nsecond line\n");
    const patch = [
      "--- a/app.txt",
      "+++ b/app.txt",
      "@@ -1,2 +1,2 @@",
      "-hello world",
      "+hello tanya",
      " second line",
      "",
    ].join("\n");
    const result = await run("apply_patch", { patch });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "app.txt"), "utf8")).toBe("hello tanya\nsecond line\n");
  });

  it("apply_patch rejects patch text without file headers", async () => {
    const result = await run("apply_patch", { patch: "not a diff at all" });
    expect(result.ok).toBe(false);
  });

  it("search_replace swaps exact strings in place", async () => {
    writeFileSync(join(workspace, "config.ts"), "const port = 3000;\n");
    const result = await run("search_replace", {
      path: "config.ts",
      old_string: "port = 3000",
      new_string: "port = 4000",
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "config.ts"), "utf8")).toBe("const port = 4000;\n");
  });

  it("copy_file duplicates a file and reports the destination", async () => {
    writeFileSync(join(workspace, "a.txt"), "payload\n");
    const result = await run("copy_file", { source: "a.txt", destination: "backup/a.txt" });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "backup/a.txt"), "utf8")).toBe("payload\n");
  });

  it("copy_dir duplicates a tree", async () => {
    mkdirSync(join(workspace, "tpl/sub"), { recursive: true });
    writeFileSync(join(workspace, "tpl/root.txt"), "r\n");
    writeFileSync(join(workspace, "tpl/sub/leaf.txt"), "l\n");
    const result = await run("copy_dir", { source: "tpl", destination: "out" });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "out/root.txt"), "utf8")).toBe("r\n");
    expect(readFileSync(join(workspace, "out/sub/leaf.txt"), "utf8")).toBe("l\n");
  });

  it("run_command executes a binary and captures output", async () => {
    const result = await run("run_command", { command: "echo", args: ["tool-check"] });
    expect(result.ok).toBe(true);
    expect(String(result.output)).toContain("tool-check");
  });

  it("run_command reports failure for a missing binary without throwing", async () => {
    const result = await run("run_command", { command: "definitely-not-a-real-binary-xyz" });
    expect(result.ok).toBe(false);
  });

  it.skipIf(!hasRg)("search finds planted content with line references", async () => {
    writeFileSync(join(workspace, "notes.md"), "alpha\nneedle-9f31\nomega\n");
    const result = await run("search", { query: "needle-9f31" });
    expect(result.ok).toBe(true);
    expect((result.output as string[]).some((line) => line.includes("needle-9f31"))).toBe(true);
  });

  it("scan_secrets passes a clean workspace and flags a hardcoded credential", async () => {
    writeFileSync(join(workspace, "clean.ts"), "export const name = \"tanya\";\n");
    const clean = await run("scan_secrets", {});
    expect(clean.ok).toBe(true);
    writeFileSync(
      join(workspace, "leak.ts"),
      "const api_key = \"sk-live-9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c\";\n",
    );
    const dirty = await run("scan_secrets", {});
    expect(dirty.ok).toBe(false);
    const findings = (dirty.output as { findings: Array<{ file: string }> }).findings;
    expect(findings.some((finding) => finding.file === "leak.ts")).toBe(true);
  });

  it("the write gate blocks protected paths end to end through registry.run", async () => {
    writeFileSync(join(workspace, "prod.env"), "KEEP=1\n");
    mkdirSync(join(workspace, ".tanya"), { recursive: true });
    writeFileSync(
      join(workspace, ".tanya/protect.json"),
      JSON.stringify({ protected: [{ text: "never touch prod env", paths: ["prod.env"], action: "block" }] }),
    );
    const result = await run("write_file", { path: "prod.env", content: "KEEP=0\n" });
    expect(result.ok).toBe(false);
    expect(readFileSync(join(workspace, "prod.env"), "utf8")).toBe("KEEP=1\n");
  });
});
