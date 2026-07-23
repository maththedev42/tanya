import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeScreenOcr, OCR_VERSION } from "../../../src/runtime/tier1/ocr";
import type { RuntimeExec } from "../../../src/runtime/types";

const HOME = "/home/tester";
const BIN_PATH = join(HOME, ".tanya", "cache", "ocr", `tanya-ocr-${OCR_VERSION}`);

function makeFakeExec(opts: {
  swiftcExit?: number;
  ocrExit?: number;
  ocrStdout?: string;
  binPreexists?: boolean;
} = {}) {
  const { swiftcExit = 0, ocrExit = 0, ocrStdout = "7\n8\n\\(n)", binPreexists = false } = opts;
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const written: Record<string, string> = {};
  const existing = new Set<string>();
  if (binPreexists) existing.add(BIN_PATH);

  const exec = {
    homeDir: () => HOME,
    fileExists: (p: string) => existing.has(p),
    mkdirp: async () => {},
    writeFile: async (p: string, data: string) => {
      written[p] = data;
    },
    run: async (_cwd: string, cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === "swiftc") {
        if (swiftcExit === 0) {
          const outIdx = args.indexOf("-o");
          if (outIdx >= 0 && args[outIdx + 1]) existing.add(args[outIdx + 1] as string);
        }
        return { exit: swiftcExit, stdout: "", stderr: "" };
      }
      // Otherwise it's the OCR binary being invoked.
      return { exit: ocrExit, stdout: ocrStdout, stderr: "" };
    },
  } as unknown as RuntimeExec;

  return { exec, calls, written };
}

const swiftcCalls = (calls: Array<{ cmd: string }>) => calls.filter((c) => c.cmd === "swiftc").length;

describe("makeScreenOcr", () => {
  it("compiles the helper once and returns recognized on-screen text", async () => {
    const { exec, calls, written } = makeFakeExec({ ocrStdout: "0\n\\(n)\n\\(n)" });
    const ocr = makeScreenOcr(exec);
    expect(await ocr.read("/frame-1.png")).toBe("0\n\\(n)\n\\(n)");
    expect(await ocr.read("/frame-2.png")).toBe("0\n\\(n)\n\\(n)");
    // Compiled exactly once across both reads.
    expect(swiftcCalls(calls)).toBe(1);
    // The embedded Swift source was written out for compilation.
    const src = Object.values(written).join("\n");
    expect(src).toContain("VNRecognizeTextRequest");
    expect(src).toContain("usesLanguageCorrection = false");
  });

  it("fails open (returns null) when the Swift toolchain is missing or the build fails", async () => {
    const { exec, calls } = makeFakeExec({ swiftcExit: 127 });
    const ocr = makeScreenOcr(exec);
    expect(await ocr.read("/frame.png")).toBeNull();
    // A second read does NOT retry the failed compile.
    expect(await ocr.read("/frame.png")).toBeNull();
    expect(swiftcCalls(calls)).toBe(1);
  });

  it("returns null when the OCR binary itself errors", async () => {
    const { exec } = makeFakeExec({ ocrExit: 4, ocrStdout: "" });
    const ocr = makeScreenOcr(exec);
    expect(await ocr.read("/frame.png")).toBeNull();
  });

  it("reuses a binary already cached on disk without recompiling", async () => {
    const { exec, calls } = makeFakeExec({ binPreexists: true, ocrStdout: "ready" });
    const ocr = makeScreenOcr(exec);
    expect(await ocr.read("/frame.png")).toBe("ready");
    expect(swiftcCalls(calls)).toBe(0);
  });

  it("returns null on empty OCR output rather than an empty string", async () => {
    const { exec } = makeFakeExec({ ocrStdout: "   \n  " });
    const ocr = makeScreenOcr(exec);
    expect(await ocr.read("/frame.png")).toBeNull();
  });
});
