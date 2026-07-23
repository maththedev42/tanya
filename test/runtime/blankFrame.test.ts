import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { isBlankImage } from "../../src/runtime/blankFrame";

describe("blank first-frame heuristic", () => {
  it("flags a solid-color screenshot as blank", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tanya-blank-"));
    const path = join(dir, "white.png");
    await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .png()
      .toFile(path);
    const result = await isBlankImage(path);
    expect(result.blank).toBe(true);
    expect(result.method).toBe("sharp-stdev");
  });

  it("accepts a screenshot with real content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tanya-blank-"));
    const path = join(dir, "noise.png");
    const pixels = Buffer.alloc(320 * 200 * 3);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 31 + (i % 7) * 113) % 256;
    await sharp(pixels, { raw: { width: 320, height: 200, channels: 3 } }).png().toFile(path);
    const result = await isBlankImage(path);
    expect(result.blank).toBe(false);
  });

  it("fails open on an unreadable path", async () => {
    const result = await isBlankImage("/nonexistent/tanya-shot.png");
    expect(result.blank).toBe(false);
    expect(result.method).toBe("unreadable");
  });
});
