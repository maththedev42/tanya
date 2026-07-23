import { join } from "node:path";
import type { RuntimeExec } from "../types";

// On-device OCR so the text-only Tier-1 agent can perceive what is LITERALLY
// drawn on screen — not just what the accessibility tree claims. This is how
// Tanya catches visual-only bugs (template artifacts like "\(n)", truncated or
// garbled text, wrong labels) whose accessibility label is still correct, while
// staying DeepSeek-only: OCR output is plain text the model reads.
//
// macOS native: a tiny Swift program using the Vision framework
// (VNRecognizeTextRequest). No vision-LLM, no API key, no brew install — it
// builds with the same Swift toolchain already required to compile iOS apps.
// Compiled once per host and cached; every failure path is fail-open (returns
// null), so OCR can only ADD signal, never break a run.

// Bump when OCR_SWIFT_SOURCE changes so cached binaries recompile.
export const OCR_VERSION = "v1";
const OCR_CHAR_CAP = 4_000;

const OCR_SWIFT_SOURCE = String.raw`
import Foundation
import AppKit
import Vision

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write(Data("usage: tanya-ocr <image>".utf8))
    exit(2)
}
let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: path),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write(Data("could not load image".utf8))
    exit(3)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
// We want the LITERAL on-screen text, not autocorrected words: "\(n)" must stay
// "\(n)", not get "corrected" into a real word.
request.usesLanguageCorrection = false
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write(Data("ocr failed: \(error)".utf8))
    exit(4)
}
var lines: [String] = []
for observation in (request.results ?? []) {
    guard let candidate = observation.topCandidates(1).first else { continue }
    lines.append(candidate.string)
}
print(lines.joined(separator: "\n"))
`;

export type ScreenOcr = {
  // Recognized on-screen text (newline-joined), or null when OCR is unavailable
  // (no Swift toolchain / not macOS) or produced nothing. Never throws.
  read(imagePath: string): Promise<string | null>;
};

type State = "unknown" | "ready" | "unavailable";

// Builds a screen OCR reader. The Swift helper is compiled lazily on first use
// and cached under ~/.tanya/cache/ocr; if the toolchain is missing or the build
// fails, the reader permanently reports unavailable for the session (fail-open).
export function makeScreenOcr(exec: RuntimeExec): ScreenOcr {
  const cacheDir = join(exec.homeDir(), ".tanya", "cache", "ocr");
  const binPath = join(cacheDir, `tanya-ocr-${OCR_VERSION}`);
  const srcPath = join(cacheDir, `ocr-${OCR_VERSION}.swift`);
  let state: State = "unknown";
  let compiling: Promise<boolean> | null = null;

  const compile = async (): Promise<boolean> => {
    try {
      if (exec.fileExists(binPath)) return true;
      await exec.mkdirp(cacheDir);
      await exec.writeFile(srcPath, OCR_SWIFT_SOURCE);
      const built = await exec.run(cacheDir, "swiftc", ["-O", "-o", binPath, srcPath], { timeoutMs: 120_000 });
      return built.exit === 0 && exec.fileExists(binPath);
    } catch {
      return false;
    }
  };

  const ensure = async (): Promise<boolean> => {
    if (state === "ready") return true;
    if (state === "unavailable") return false;
    if (!compiling) compiling = compile();
    const ok = await compiling;
    state = ok ? "ready" : "unavailable";
    return ok;
  };

  return {
    async read(imagePath: string): Promise<string | null> {
      if (!(await ensure())) return null;
      try {
        const result = await exec.run(cacheDir, binPath, [imagePath], { timeoutMs: 20_000 });
        if (result.exit !== 0) return null;
        const text = result.stdout.trim();
        if (!text) return null;
        return text.length > OCR_CHAR_CAP ? `${text.slice(0, OCR_CHAR_CAP)}\n(... text truncated ...)` : text;
      } catch {
        return null;
      }
    },
  };
}
