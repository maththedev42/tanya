import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import type { TanyaTool, ToolContext, ToolResult } from "./types";
import { resolveInsideWorkspace } from "../safety/workspace";

const execFileAsync = promisify(execFile);

const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif", ".tiff", ".bmp"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Injectable so tests never compile Swift or require macOS. Production wires the
 * real Vision-backed helper; tests stub every seam.
 */
export interface OcrDeps {
  platform: string;
  /** Whether `swiftc` is reachable (Xcode command line tools installed). */
  hasSwiftc(): Promise<boolean>;
  /** Compile-on-first-use; returns the path to the runnable helper binary. */
  ensureBinary(): Promise<string>;
  /** Run the helper on an absolute image path, returning recognized text. */
  runBinary(binaryPath: string, imagePath: string): Promise<string>;
  /** File size in bytes, or null if the file does not exist. */
  statSize(path: string): Promise<number | null>;
}

const OCR_HELPER_SOURCE = `import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count >= 2 else {
  FileHandle.standardError.write("usage: tanya-ocr <image>\\n".data(using: .utf8)!)
  exit(2)
}
let url = URL(fileURLWithPath: args[1])
guard let image = NSImage(contentsOf: url),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("could not load image\\n".data(using: .utf8)!)
  exit(3)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["pt-BR", "en-US"]
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([request]) } catch {
  FileHandle.standardError.write("ocr failed\\n".data(using: .utf8)!)
  exit(4)
}
let observations = request.results ?? []
let lines = observations
  .sorted { $0.boundingBox.origin.y > $1.boundingBox.origin.y }
  .compactMap { $0.topCandidates(1).first?.string }
print(lines.joined(separator: "\\n"))
`;

function binaryPath(): string {
  return join(homedir(), ".tanya", "bin", "tanya-ocr");
}

export function productionOcrDeps(): OcrDeps {
  return {
    platform: process.platform,
    async hasSwiftc() {
      try {
        await execFileAsync("xcrun", ["-f", "swiftc"]);
        return true;
      } catch {
        return false;
      }
    },
    async ensureBinary() {
      const bin = binaryPath();
      if (existsSync(bin)) return bin;
      await mkdir(join(homedir(), ".tanya", "bin"), { recursive: true });
      const src = join(tmpdir(), `tanya-ocr-${process.pid}.swift`);
      await writeFile(src, OCR_HELPER_SOURCE, "utf8");
      await execFileAsync("xcrun", ["swiftc", "-O", "-framework", "Vision", "-framework", "AppKit", src, "-o", bin]);
      return bin;
    },
    async runBinary(bin, imagePath) {
      const { stdout } = await execFileAsync(bin, [imagePath], { maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    },
    async statSize(path) {
      try {
        return (await stat(path)).size;
      } catch {
        return null;
      }
    },
  };
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

export async function runReadImage(input: unknown, context: ToolContext, deps: OcrDeps): Promise<ToolResult> {
  const rawPath = asRecord(input).path;
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { ok: false, summary: "read_image needs a `path`.", error: "Missing string field: path" };
  }
  const relative = rawPath.trim();

  let absolute: string;
  try {
    absolute = resolveInsideWorkspace(context.workspace, relative);
  } catch (error) {
    return { ok: false, summary: "Path is outside the workspace.", error: error instanceof Error ? error.message : String(error) };
  }

  const ext = extname(absolute).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      summary: `Unsupported image type: ${ext || "(none)"}.`,
      error: `read_image supports ${[...SUPPORTED_EXTENSIONS].join(", ")}`,
    };
  }

  const size = await deps.statSize(absolute);
  if (size === null) {
    return { ok: false, summary: `Image not found: ${relative}.`, error: `No such file: ${relative}` };
  }
  if (size > MAX_IMAGE_BYTES) {
    return { ok: false, summary: `Image too large (${Math.round(size / 1024 / 1024)}MB, max 20MB).`, error: "Image exceeds 20MB" };
  }

  if (deps.platform !== "darwin") {
    return {
      ok: false,
      summary: "read_image is only available on macOS.",
      error: "read_image needs macOS with the Vision framework (Xcode command line tools).",
    };
  }
  if (!(await deps.hasSwiftc())) {
    return {
      ok: false,
      summary: "read_image needs Xcode command line tools.",
      error: "swiftc not found — install with `xcode-select --install`.",
    };
  }

  let binaryPathResolved: string;
  try {
    binaryPathResolved = await deps.ensureBinary();
  } catch (error) {
    return { ok: false, summary: "Failed to build the OCR helper.", error: error instanceof Error ? error.message : String(error) };
  }

  let text: string;
  try {
    text = (await deps.runBinary(binaryPathResolved, absolute)).replace(/\s+$/, "");
  } catch (error) {
    return { ok: false, summary: "OCR failed to read the image.", error: error instanceof Error ? error.message : String(error) };
  }

  const lineCount = text ? text.split("\n").filter((line) => line.trim()).length : 0;
  return {
    ok: true,
    summary: text ? `OCR of ${basename(absolute)}: ${lineCount} line(s) of text.` : `OCR of ${basename(absolute)}: no text found.`,
    output: text || "(no text recognized in the image)",
  };
}

export const readImageTool: TanyaTool = {
  name: "read_image",
  description:
    "Read the text in an image (screenshot, diagram, error dialog) via on-device OCR. Give a workspace-relative `path`. macOS only; text-only models can't see pixels, so this is how you read an attached image.",
  definition: {
    type: "function",
    function: {
      name: "read_image",
      description: "OCR an image file in the workspace and return its text. Use for screenshots and error dialogs.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path to a png/jpg/jpeg/gif/webp/heic image." },
        },
        required: ["path"],
      },
    },
  },
  run(input, context) {
    return runReadImage(input, context, productionOcrDeps());
  },
};
