import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WRITE_CAPABLE_TOOLS,
  collectPatchTargets,
  collectWriteTargets,
  compileGlob,
  drainProtectHoldLog,
  evaluateToolGate,
  loadProtectRules,
  normalizeWriteTarget,
} from "../toolGate";

describe("toolGate — write-target collection", () => {
  it("collects path-shaped params per tool", () => {
    expect(collectWriteTargets("write_file", { path: "src/a.ts", content: "x" })).toEqual(["src/a.ts"]);
    expect(collectWriteTargets("search_replace", { path: "b.md", old_string: "x", new_string: "y" })).toEqual(["b.md"]);
    expect(collectWriteTargets("edit_block", { path: "c.swift", search: "x", replace: "y" })).toEqual(["c.swift"]);
    expect(collectWriteTargets("copy_file", { source: "a", destination: "d/e.txt" })).toEqual(["d/e.txt"]);
    expect(collectWriteTargets("copy_dir", { source: "a", destination: "dir" })).toEqual(["dir"]);
    expect(collectWriteTargets("apply_artifact", { artifactPath: ".tanya/artifacts/x", targetPath: "ios/X.swift" })).toEqual(["ios/X.swift"]);
  });

  it("returns [] for non-write tools, unknown shapes, and malformed input", () => {
    expect(collectWriteTargets("read_file", { path: "a.ts" })).toEqual([]);
    expect(collectWriteTargets("write_file", { content: "no path" })).toEqual([]);
    expect(collectWriteTargets("write_file", null)).toEqual([]);
    expect(collectWriteTargets("write_file", "path")).toEqual([]);
  });

  it("parses unified-diff headers, stripping a/ b/ prefixes", () => {
    const patch = [
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");
    expect(collectPatchTargets(patch)).toEqual(["src/new.ts"]);
  });

  it("falls back to the --- side for deletions (+++ /dev/null)", () => {
    const patch = [
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-x",
    ].join("\n");
    expect(collectPatchTargets(patch)).toEqual(["src/gone.ts"]);
  });

  it("dedupes targets across hunks and ignores timestamp suffixes", () => {
    const patch = [
      "--- a/x.ts\t2026-01-01",
      "+++ b/x.ts\t2026-01-02",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -5 +5 @@",
      "-c",
      "+d",
    ].join("\n");
    expect(collectPatchTargets(patch)).toEqual(["x.ts"]);
  });

  it("normalizes targets workspace-relative with lexical ../ collapse", () => {
    expect(normalizeWriteTarget("/ws", "src/./a/../b.ts")).toBe("src/b.ts");
    expect(normalizeWriteTarget("/ws", "/ws/src/c.ts")).toBe("src/c.ts");
    // Escapes are kept visible (over-collection), not silently dropped.
    expect(normalizeWriteTarget("/ws", "../outside.ts")).toBe("../outside.ts");
  });

  it("evaluateToolGate allows everything today and reports normalized targets", () => {
    const write = evaluateToolGate({ toolName: "write_file", input: { path: "a/../b.ts", content: "" }, workspace: "/ws" });
    expect(write.allowed).toBe(true);
    expect(write.targets).toEqual(["b.ts"]);
    const read = evaluateToolGate({ toolName: "read_file", input: { path: "a.ts" }, workspace: "/ws" });
    expect(read.allowed).toBe(true);
    expect(read.targets).toEqual([]);
  });

  it("covers the direct file-writing tool surface", () => {
    for (const name of ["write_file", "apply_patch", "search_replace", "edit_block", "copy_file", "copy_dir", "apply_artifact"]) {
      expect(WRITE_CAPABLE_TOOLS.has(name)).toBe(true);
    }
  });
});

describe("toolGate — glob compiler", () => {
  it("matches segments, subtrees, and single chars", () => {
    expect(compileGlob("src/*.ts").test("src/a.ts")).toBe(true);
    expect(compileGlob("src/*.ts").test("src/deep/a.ts")).toBe(false);
    expect(compileGlob("src/**").test("src/deep/a.ts")).toBe(true);
    expect(compileGlob("**/*.swift").test("apps/macos/X.swift")).toBe(true);
    expect(compileGlob("**/*.swift").test("X.swift")).toBe(true);
    expect(compileGlob("a/**/b.ts").test("a/b.ts")).toBe(true);
    expect(compileGlob("a/**/b.ts").test("a/x/y/b.ts")).toBe(true);
    expect(compileGlob("file?.md").test("file1.md")).toBe(true);
    expect(compileGlob("file?.md").test("file12.md")).toBe(false);
    expect(compileGlob("exact/path.ts").test("exact/path.ts")).toBe(true);
    expect(compileGlob("exact/path.ts").test("exact/path.ts.bak")).toBe(false);
  });

  it("escapes regex metacharacters in literals", () => {
    expect(compileGlob("a+b(c).ts").test("a+b(c).ts")).toBe(true);
    expect(compileGlob("a.ts").test("axts")).toBe(false);
  });
});

describe("toolGate — protected-path write holds", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "tanya-toolgate-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function writeProtect(content: unknown): void {
    mkdirSync(join(workspace, ".tanya"), { recursive: true });
    writeFileSync(join(workspace, ".tanya", "protect.json"), typeof content === "string" ? content : JSON.stringify(content), "utf8");
  }

  it("blocks a write to a protected path and names the invariant", () => {
    writeProtect({ protected: [{ text: "WIP of another session", paths: ["apps/Sheet.swift"], action: "block" }] });
    const decision = evaluateToolGate({
      toolName: "write_file",
      input: { path: "apps/Sheet.swift", content: "x" },
      workspace,
      runId: "r-test-1",
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.refusal.ok).toBe(false);
      expect(decision.refusal.error).toContain("WIP of another session");
      expect(decision.refusal.error).toContain("apps/Sheet.swift");
    }
    expect(drainProtectHoldLog("r-test-1")).toEqual([
      "protect-hold: BLOCK write_file apps/Sheet.swift (WIP of another session)",
    ]);
    // Drained: a second read is empty.
    expect(drainProtectHoldLog("r-test-1")).toEqual([]);
  });

  it("ask action also blocks (fails closed)", () => {
    writeProtect({ protected: [{ text: "needs a human", paths: ["a.ts"], action: "ask" }] });
    const decision = evaluateToolGate({ toolName: "write_file", input: { path: "a.ts", content: "" }, workspace });
    expect(decision.allowed).toBe(false);
  });

  it("path spelling cannot evade a hold (lexical .. collapse)", () => {
    writeProtect({ protected: [{ text: "locked", paths: ["apps/macos/**"] }] });
    const decision = evaluateToolGate({
      toolName: "write_file",
      input: { path: "apps/./other/../macos/X.swift", content: "" },
      workspace,
    });
    expect(decision.allowed).toBe(false);
  });

  it("holds apply_patch when a diff header targets a protected path", () => {
    writeProtect({ protected: [{ text: "locked", paths: ["src/core/**"] }] });
    const patch = ["--- a/src/core/x.ts", "+++ b/src/core/x.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    const decision = evaluateToolGate({ toolName: "apply_patch", input: { patch }, workspace });
    expect(decision.allowed).toBe(false);
  });

  it("allows writes to unprotected paths and non-write tools", () => {
    writeProtect({ protected: [{ text: "locked", paths: ["locked/**"] }] });
    expect(evaluateToolGate({ toolName: "write_file", input: { path: "open/a.ts", content: "" }, workspace }).allowed).toBe(true);
    expect(evaluateToolGate({ toolName: "read_file", input: { path: "locked/a.ts" }, workspace }).allowed).toBe(true);
  });

  it("failures degrade toward zero holds: missing/malformed files and entries", () => {
    expect(loadProtectRules(workspace)).toEqual([]);
    writeProtect("{not json");
    expect(loadProtectRules(workspace)).toEqual([]);
    writeProtect({ protected: "nope" });
    expect(loadProtectRules(workspace)).toEqual([]);
    writeProtect({ protected: [{ text: "no paths" }, { paths: [] }, { paths: ["ok.ts"] }] });
    const rules = loadProtectRules(workspace);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.paths).toEqual(["ok.ts"]);
    expect(rules[0]!.action).toBe("block");
    expect(rules[0]!.text).toBe("protected path");
  });

  it("picks up rule-file edits (cache keys on mtime+size)", () => {
    writeProtect({ protected: [{ text: "v1", paths: ["one.ts"] }] });
    expect(evaluateToolGate({ toolName: "write_file", input: { path: "one.ts", content: "" }, workspace }).allowed).toBe(false);
    writeProtect({ protected: [{ text: "v2 — different set", paths: ["two.ts"] }] });
    expect(evaluateToolGate({ toolName: "write_file", input: { path: "one.ts", content: "" }, workspace }).allowed).toBe(true);
    expect(evaluateToolGate({ toolName: "write_file", input: { path: "two.ts", content: "" }, workspace }).allowed).toBe(false);
  });
});
