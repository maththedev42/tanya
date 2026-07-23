import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { appendFile, writeFile as fsWriteFile } from "node:fs/promises";
import http from "node:http";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { realShell } from "../agent/verifier/shell";
import { processEnvWithStandardPath } from "../tools/fsTools";
import { isBlankImage } from "./blankFrame";
import type { HttpResponseSummary, LaunchHandle, LaunchOptions, RuntimeExec } from "./types";

const LOG_RING_CAP_BYTES = 64 * 1024;
const KILL_GRACE_MS = 2_000;

// Base env for everything the harness runs: inherited env + standard bin dirs
// (same fix as bare tool spawns) + the Android SDK dirs so adb/emulator resolve
// even when ANDROID_HOME isn't exported in the calling shell, + pipx's bin dir
// so idb (Tier-1 iOS tap/type) resolves when Tanya is spawned by a worker
// whose PATH lacks it.
export function runtimeBaseEnv(): NodeJS.ProcessEnv {
  const env = processEnvWithStandardPath();
  const sdkRoots = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    join(homedir(), "Library", "Android", "sdk"),
  ].filter((root): root is string => Boolean(root && root.trim()));
  const parts = (env.PATH ?? "").split(":").filter(Boolean);
  for (const root of sdkRoots) {
    for (const dir of [join(root, "platform-tools"), join(root, "emulator")]) {
      if (!parts.includes(dir)) parts.push(dir);
    }
  }
  const pipxBin = join(homedir(), ".local", "bin");
  if (!parts.includes(pipxBin)) parts.push(pipxBin);
  return { ...env, PATH: parts.join(":") };
}

function realLaunch(options: LaunchOptions): Promise<LaunchHandle> {
  return new Promise((resolveHandle) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      shell: false,
      detached: process.platform !== "win32",
      env: { ...runtimeBaseEnv(), ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let ring = "";
    const appendLog = (chunk: Buffer) => {
      ring += chunk.toString();
      if (ring.length > LOG_RING_CAP_BYTES) ring = ring.slice(ring.length - LOG_RING_CAP_BYTES);
      if (options.logPath) void appendFile(options.logPath, chunk).catch(() => {});
    };
    child.stdout?.on("data", appendLog);
    child.stderr?.on("data", appendLog);

    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let exitNotify: (() => void) | null = null;
    const exited = new Promise<void>((resolveExit) => {
      exitNotify = resolveExit;
    });
    const markExited = (info: { code: number | null; signal: NodeJS.Signals | null }) => {
      if (exitInfo) return;
      exitInfo = info;
      exitNotify?.();
    };
    child.on("exit", (code, signal) => markExited({ code, signal }));
    child.on("error", (err) => {
      ring += `\n[launch error] ${err.message}`;
      markExited({ code: null, signal: null });
    });

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Process group already gone; fall through to the direct child.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // Already exited.
      }
    };

    const stopWith = async (signal: NodeJS.Signals) => {
      if (exitInfo) return;
      killGroup(signal);
      await Promise.race([exited, delay(KILL_GRACE_MS)]);
      if (!exitInfo) killGroup("SIGKILL");
      await Promise.race([exited, delay(KILL_GRACE_MS)]);
    };

    const handle: LaunchHandle = {
      pid: null,
      alive: () => exitInfo === null,
      exit: () => exitInfo,
      logTail: (maxBytes = LOG_RING_CAP_BYTES) => ring.slice(-maxBytes),
      waitExit: async (ms) => {
        if (exitInfo) return true;
        await Promise.race([exited, delay(ms)]);
        return exitInfo !== null;
      },
      killTree: () => stopWith("SIGTERM"),
      interrupt: () => stopWith("SIGINT"),
    };

    child.once("spawn", () => {
      handle.pid = child.pid ?? null;
      resolveHandle(handle);
    });
    child.once("error", () => resolveHandle(handle));
  });
}

// NEVER unref this timer: an awaited sleep must keep the process alive. With
// an unref'd timer, a boot test whose launched app is not our child (iOS
// simctl launch) had an empty event loop during the warmup sleep — node
// exited 0 mid-run with no verdict. Caught live on the first real iOS smoke.
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function realFetchUrl(url: string, timeoutMs: number): Promise<HttpResponseSummary | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
    const body = await response.text().catch(() => "");
    return { status: response.status, body: body.slice(0, 64 * 1024) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function ephemeralPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        if (port > 0) resolvePort(port);
        else rejectPort(new Error("could not allocate an ephemeral port"));
      });
    });
  });
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Minimal static file server for landing pages (plain index.html projects) so
// Tier-0 web checks need no external serve dependency.
export async function serveStaticDir(dir: string): Promise<{ port: number; close(): Promise<void> }> {
  const root = normalize(dir);
  const server = http.createServer((request, response) => {
    try {
      const urlPath = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
      let filePath = normalize(join(root, urlPath));
      if (filePath !== root && !filePath.startsWith(root + sep)) {
        response.writeHead(403);
        response.end();
        return;
      }
      if (existsSync(filePath) && statSync(filePath).isDirectory()) {
        filePath = join(filePath, "index.html");
      }
      if (!existsSync(filePath)) {
        response.writeHead(404);
        response.end("not found");
        return;
      }
      response.writeHead(200, {
        "content-type": STATIC_CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      });
      response.end(readFileSync(filePath));
    } catch (err) {
      response.writeHead(500);
      response.end(err instanceof Error ? err.message : String(err));
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections?.();
      }),
  };
}

export type HttpProbeOutcome = {
  up: boolean;
  status?: number;
  bodyExcerpt?: string;
  attempts: number;
};

// Poll a URL until it answers. By default any HTTP status < 500 counts as
// "the server is up" (a 404 on / is still a booted server); pass `accept` for
// stricter surfaces (web pages want a real 2xx/3xx with a body). null
// responses are connection failures. Probes at least once even with a zero
// budget.
export async function waitForHttp(
  exec: Pick<RuntimeExec, "fetchUrl" | "sleep" | "now">,
  url: string,
  options: {
    totalMs: number;
    intervalMs?: number;
    requestTimeoutMs?: number;
    accept?: (response: HttpResponseSummary) => boolean;
  },
): Promise<HttpProbeOutcome> {
  const deadline = exec.now() + options.totalMs;
  const interval = options.intervalMs ?? 500;
  const accept = options.accept ?? ((response: HttpResponseSummary) => response.status < 500);
  let attempts = 0;
  let last: HttpResponseSummary | null = null;
  do {
    attempts += 1;
    last = await exec.fetchUrl(url, options.requestTimeoutMs ?? 3_000);
    if (last && accept(last)) {
      return { up: true, status: last.status, bodyExcerpt: last.body.slice(0, 400), attempts };
    }
    if (exec.now() >= deadline) break;
    await exec.sleep(interval);
  } while (exec.now() < deadline);
  return {
    up: false,
    ...(last ? { status: last.status, bodyExcerpt: last.body.slice(0, 400) } : {}),
    attempts,
  };
}

export function realRuntimeExec(): RuntimeExec {
  return {
    run: (cwd, command, args, options) =>
      realShell(cwd, command, args, {
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        env: options?.env ?? runtimeBaseEnv(),
      }),
    launch: realLaunch,
    fileExists: (path) => existsSync(path),
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    writeFile: async (path, data) => {
      await fsWriteFile(path, data, "utf8");
    },
    mkdirp: async (path) => {
      mkdirSync(path, { recursive: true });
    },
    listDir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    statMtimeMs: (path) => {
      try {
        return statSync(path).mtimeMs;
      } catch {
        return null;
      }
    },
    fetchUrl: realFetchUrl,
    isBlankImage,
    ephemeralPort,
    homeDir: () => homedir(),
    sleep: delay,
    now: () => Date.now(),
  };
}
