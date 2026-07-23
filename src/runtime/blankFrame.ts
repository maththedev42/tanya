import { statSync } from "node:fs";

export type BlankImageResult = {
  blank: boolean;
  method: "sharp-stdev" | "size-heuristic" | "unreadable";
  detail: string;
};

// "Did the app render anything?" — a solid-color first frame (white/black
// screen of death) has near-zero per-channel standard deviation. sharp is
// already a dependency; if its native install is broken we degrade to a
// file-size heuristic and finally fail OPEN (a heuristic must never produce
// a false RED on its own).
export async function isBlankImage(path: string): Promise<BlankImageResult> {
  try {
    const sharp = (await import("sharp")).default;
    const stats = await sharp(path).stats();
    const maxStdev = Math.max(...stats.channels.map((channel) => channel.stdev));
    return {
      blank: maxStdev < 2,
      method: "sharp-stdev",
      detail: `max channel stdev ${maxStdev.toFixed(2)}`,
    };
  } catch {
    // sharp unavailable or undecodable image — try the cheap heuristic.
  }
  try {
    const size = statSync(path).size;
    return {
      blank: size < 4_096,
      method: "size-heuristic",
      detail: `file size ${size} bytes (solid-color screenshots compress tiny)`,
    };
  } catch (err) {
    return {
      blank: false,
      method: "unreadable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
