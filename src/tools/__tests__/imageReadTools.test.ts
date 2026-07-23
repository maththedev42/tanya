import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runReadImage, type OcrDeps } from "../imageReadTools";
import type { ToolContext } from "../types";

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "tanya-readimage-"));
  writeFileSync(join(dir, "shot.png"), "fake-png-bytes");
  return dir;
}

function ctx(ws: string): ToolContext {
  return { workspace: ws };
}

function deps(overrides: Partial<OcrDeps> = {}): OcrDeps {
  return {
    platform: "darwin",
    hasSwiftc: async () => true,
    ensureBinary: async () => "/fake/tanya-ocr",
    runBinary: async () => "Error: build failed\nline 42: undefined symbol\n",
    statSize: async () => 1234,
    ...overrides,
  };
}

describe("runReadImage", () => {
  it("returns OCR text and a line count on success", async () => {
    const ws = workspace();
    let ranWith: [string, string] | null = null;
    const result = await runReadImage({ path: "shot.png" }, ctx(ws), deps({
      runBinary: async (bin, img) => { ranWith = [bin, img]; return "Hello\nWorld\n"; },
    }));

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("2 line(s)");
    expect(result.output).toBe("Hello\nWorld");
    expect(ranWith![0]).toBe("/fake/tanya-ocr");
    expect(ranWith![1]).toContain("shot.png");
  });

  it("degrades gracefully off macOS without touching the binary", async () => {
    const ws = workspace();
    let ensured = false;
    const result = await runReadImage({ path: "shot.png" }, ctx(ws), deps({
      platform: "linux",
      ensureBinary: async () => { ensured = true; return "x"; },
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("macOS");
    expect(ensured).toBe(false);
  });

  it("reports a clear error when swiftc is missing", async () => {
    const ws = workspace();
    const result = await runReadImage({ path: "shot.png" }, ctx(ws), deps({ hasSwiftc: async () => false }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("swiftc");
  });

  it("rejects a missing file and an oversized file", async () => {
    const ws = workspace();
    const missing = await runReadImage({ path: "nope.png" }, ctx(ws), deps({ statSize: async () => null }));
    expect(missing.ok).toBe(false);
    expect(missing.summary).toContain("not found");

    const huge = await runReadImage({ path: "shot.png" }, ctx(ws), deps({ statSize: async () => 40 * 1024 * 1024 }));
    expect(huge.ok).toBe(false);
    expect(huge.summary).toContain("too large");
  });

  it("rejects unsupported extensions and missing paths", async () => {
    const ws = workspace();
    writeFileSync(join(ws, "notes.txt"), "x");
    const wrongType = await runReadImage({ path: "notes.txt" }, ctx(ws), deps());
    expect(wrongType.ok).toBe(false);
    expect(wrongType.summary).toContain("Unsupported");

    const noPath = await runReadImage({}, ctx(ws), deps());
    expect(noPath.ok).toBe(false);
    expect(noPath.error).toContain("path");
  });

  it("refuses a path escaping the workspace", async () => {
    const ws = workspace();
    const result = await runReadImage({ path: "../../etc/passwd.png" }, ctx(ws), deps());
    expect(result.ok).toBe(false);
  });

  it("reports no-text-found without failing", async () => {
    const ws = workspace();
    const result = await runReadImage({ path: "shot.png" }, ctx(ws), deps({ runBinary: async () => "\n  \n" }));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("no text found");
  });
});
