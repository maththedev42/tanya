import type { RuntimeExec } from "../types";
import type { InteractDriver } from "./types";

// Platform interaction drivers. The model-facing coordinate space is the UI
// tree's native space per platform: iOS accessibility frames are POINTS (what
// idb taps), Android uiautomator bounds are PIXELS (what input tap uses) —
// so tap(x, y) passes coordinates straight through on both platforms.

const TREE_CHAR_CAP = 16_000;

type UiElement = {
  role: string;
  label: string;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  clickable?: boolean;
};

function renderTree(screen: string, elements: UiElement[]): string {
  const lines = [screen];
  for (const el of elements) {
    const label = el.label ? ` "${el.label}"` : "";
    const tag = el.clickable ? " [clickable]" : "";
    lines.push(`${el.role}${label} center=(${el.centerX},${el.centerY}) size=${el.width}x${el.height}${tag}`);
  }
  let text = lines.join("\n");
  if (text.length > TREE_CHAR_CAP) {
    text = `${text.slice(0, TREE_CHAR_CAP)}\n(... tree truncated ...)`;
  }
  return text;
}

// iOS — UI tree + tap/type via idb (Facebook iOS Development Bridge),
// screenshot via simctl. idb is required for Tier-1 on iOS: without it there
// is no tree and no input, so the adapter hook skips the UI test.
export async function makeIosInteractDriver(
  exec: RuntimeExec,
  workspace: string,
  udid: string,
): Promise<InteractDriver> {
  const idbCheck = await exec.run(workspace, "which", ["idb"], { timeoutMs: 5_000 });
  const canTap = idbCheck.exit === 0;

  return {
    canTap,
    async describeUi(): Promise<string | null> {
      if (!canTap) return null;
      const result = await exec.run(workspace, "idb", ["ui", "describe-all", "--udid", udid, "--json"], {
        timeoutMs: 60_000,
      });
      if (result.exit !== 0) return null;
      try {
        const parsed = JSON.parse(result.stdout) as Array<{
          AXLabel?: string | null;
          type?: string | null;
          frame?: { x?: number; y?: number; width?: number; height?: number } | null;
        }>;
        if (!Array.isArray(parsed)) return null;
        let screen = "Screen size unknown";
        const elements: UiElement[] = [];
        for (const node of parsed) {
          const frame = node.frame ?? {};
          const width = Math.round(frame.width ?? 0);
          const height = Math.round(frame.height ?? 0);
          const role = (node.type ?? "Element").trim() || "Element";
          if (role === "Application") {
            screen = `Screen: ${width}x${height} (coordinates below are tap-ready)`;
            continue;
          }
          elements.push({
            role,
            label: (node.AXLabel ?? "").trim(),
            centerX: Math.round((frame.x ?? 0) + (frame.width ?? 0) / 2),
            centerY: Math.round((frame.y ?? 0) + (frame.height ?? 0) / 2),
            width,
            height,
          });
        }
        return renderTree(screen, elements);
      } catch {
        return null;
      }
    },
    async screenshot(path: string): Promise<boolean> {
      const result = await exec.run(workspace, "xcrun", ["simctl", "io", udid, "screenshot", path], {
        timeoutMs: 30_000,
      });
      return result.exit === 0;
    },
    async tap(x: number, y: number): Promise<void> {
      if (!canTap) return;
      await exec.run(workspace, "idb", ["ui", "tap", "--udid", udid, String(Math.round(x)), String(Math.round(y))], {
        timeoutMs: 15_000,
      });
    },
    async typeText(text: string): Promise<void> {
      if (!canTap) return;
      await exec.run(workspace, "idb", ["ui", "text", "--udid", udid, text], {
        timeoutMs: 15_000,
      });
    },
  };
}

const ANDROID_NODE_RE = /<node[^>]*>/g;

function attr(node: string, name: string): string {
  const match = new RegExp(`${name}="([^"]*)"`).exec(node);
  return match?.[1] ?? "";
}

export function parseUiautomatorTree(xml: string): string | null {
  if (!xml.includes("<hierarchy")) return null;
  let screen = "Screen size unknown";
  const elements: UiElement[] = [];
  for (const node of xml.match(ANDROID_NODE_RE) ?? []) {
    const bounds = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attr(node, "bounds"));
    if (!bounds) continue;
    const [x1, y1, x2, y2] = [Number(bounds[1]), Number(bounds[2]), Number(bounds[3]), Number(bounds[4])];
    const text = attr(node, "text");
    const desc = attr(node, "content-desc");
    const clickable = attr(node, "clickable") === "true";
    const className = attr(node, "class");
    const role = className.split(".").pop() || "View";
    if (role === "FrameLayout" && x1 === 0 && y1 === 0 && elements.length === 0) {
      screen = `Screen: ${x2}x${y2} (coordinates below are tap-ready)`;
    }
    // Keep the signal: labeled or interactive nodes only.
    if (!text && !desc && !clickable) continue;
    elements.push({
      role,
      label: text || desc,
      centerX: Math.round((x1 + x2) / 2),
      centerY: Math.round((y1 + y2) / 2),
      width: x2 - x1,
      height: y2 - y1,
      clickable,
    });
  }
  return renderTree(screen, elements);
}

// Android — everything goes through adb, which is already a given when the
// adapter reaches Tier-1, so canTap is always true.
export function makeAndroidInteractDriver(
  exec: RuntimeExec,
  workspace: string,
  serial: string | null,
): InteractDriver {
  const REMOTE_SHOT = "/sdcard/tanya-tier1.png";
  const REMOTE_TREE = "/sdcard/tanya-ui.xml";
  const adb = (args: string[], timeoutMs: number) =>
    exec.run(workspace, "adb", serial ? ["-s", serial, ...args] : args, { timeoutMs });

  return {
    canTap: true,
    async describeUi(): Promise<string | null> {
      await adb(["shell", "uiautomator", "dump", REMOTE_TREE], 30_000);
      const cat = await adb(["shell", "cat", REMOTE_TREE], 30_000);
      await adb(["shell", "rm", "-f", REMOTE_TREE], 15_000).catch(() => undefined);
      if (cat.exit !== 0) return null;
      return parseUiautomatorTree(cat.stdout);
    },
    async screenshot(path: string): Promise<boolean> {
      const cap = await adb(["shell", "screencap", "-p", REMOTE_SHOT], 30_000);
      if (cap.exit !== 0) return false;
      const pulled = await adb(["pull", REMOTE_SHOT, path], 30_000);
      await adb(["shell", "rm", "-f", REMOTE_SHOT], 15_000).catch(() => undefined);
      return pulled.exit === 0 && exec.fileExists(path);
    },
    async tap(x: number, y: number): Promise<void> {
      await adb(["shell", "input", "tap", String(Math.round(x)), String(Math.round(y))], 15_000);
    },
    async typeText(text: string): Promise<void> {
      // `input text` rejects literal spaces (%s is its escape); everything else
      // passes through the device shell, so single-quote the payload.
      const escaped = `'${text.replace(/ /g, "%s").replace(/'/g, `'\\''`)}'`;
      await adb(["shell", "input", "text", escaped], 15_000);
    },
  };
}
