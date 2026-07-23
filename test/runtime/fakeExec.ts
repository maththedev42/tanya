import type {
  HttpResponseSummary,
  LaunchHandle,
  LaunchOptions,
  RuntimeExec,
} from "../../src/runtime/types";

export type RunCall = { cwd: string; command: string; args: string[]; timeoutMs?: number | undefined };
export type RunResponse = {
  exit?: number;
  stdout?: string;
  stderr?: string;
  binaryMissing?: boolean;
  timedOut?: boolean;
};

export type LaunchScript = {
  // Virtual ms after launch when the process exits on its own; omit = stays alive.
  exitAfterMs?: number;
  exitCode?: number | null;
  log?: string;
};

export type FakeLaunchRecord = {
  options: LaunchOptions;
  handle: LaunchHandle;
  killed: boolean;
  killCalls: number;
  interruptCalls: number;
};

export type FakeExec = RuntimeExec & {
  calls: RunCall[];
  launches: FakeLaunchRecord[];
  written: Record<string, string>;
  clock(): number;
};

// Hermetic RuntimeExec: scripted command responses, virtual clock advanced by
// sleep/waitExit (no real waiting), in-memory filesystem keyed by full path.
export function makeFakeExec(config: {
  files?: Record<string, string>;
  mtimes?: Record<string, number>;
  respond?: (call: RunCall) => RunResponse | undefined;
  launchScript?: (options: LaunchOptions) => LaunchScript | undefined;
  fetch?: (url: string, nowMs: number) => HttpResponseSummary | null;
  blankImage?: (path: string) => boolean;
} = {}): FakeExec {
  let nowMs = 1_000_000;
  const files = new Map(Object.entries(config.files ?? {}));
  const mtimes = new Map(Object.entries(config.mtimes ?? {}));
  const calls: RunCall[] = [];
  const launches: FakeLaunchRecord[] = [];
  const written: Record<string, string> = {};
  let nextPort = 42_000;

  const fileExists = (path: string): boolean => {
    if (files.has(path)) return true;
    const prefix = path.endsWith("/") ? path : `${path}/`;
    for (const key of files.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  };

  const exec: FakeExec = {
    run: async (cwd, command, args, options) => {
      const call: RunCall = { cwd, command, args, timeoutMs: options?.timeoutMs };
      calls.push(call);
      const out = config.respond?.(call) ?? {};
      return {
        exit: out.exit ?? 0,
        stdout: out.stdout ?? "",
        stderr: out.stderr ?? "",
        ...(out.timedOut ? { timedOut: true } : {}),
        ...(out.binaryMissing ? { binaryMissing: true } : {}),
      };
    },
    launch: async (options) => {
      const script = config.launchScript?.(options) ?? {};
      const startedAt = nowMs;
      const exitedAt = (): number | null =>
        script.exitAfterMs !== undefined ? startedAt + script.exitAfterMs : null;
      const record: FakeLaunchRecord = { options, killed: false, killCalls: 0, interruptCalls: 0, handle: null as unknown as LaunchHandle };
      const exitInfo = (): { code: number | null; signal: NodeJS.Signals | null } | null => {
        if (record.killed) return { code: null, signal: "SIGTERM" };
        const at = exitedAt();
        if (at !== null && nowMs >= at) return { code: script.exitCode ?? 0, signal: null };
        return null;
      };
      const handle: LaunchHandle = {
        pid: 4242,
        alive: () => exitInfo() === null,
        exit: () => exitInfo(),
        logTail: () => script.log ?? "",
        waitExit: async (ms) => {
          const at = exitedAt();
          if (at !== null && at <= nowMs + ms) {
            nowMs = Math.max(nowMs, at);
            return true;
          }
          nowMs += ms;
          return exitInfo() !== null;
        },
        killTree: async () => {
          record.killCalls += 1;
          // Mirrors the real handle: killing an already-exited process is a no-op.
          if (exitInfo() === null) record.killed = true;
        },
        interrupt: async () => {
          record.interruptCalls += 1;
          if (exitInfo() === null) record.killed = true;
        },
      };
      record.handle = handle;
      launches.push(record);
      return handle;
    },
    fileExists,
    readText: (path) => files.get(path) ?? null,
    writeFile: async (path, data) => {
      files.set(path, data);
      written[path] = data;
    },
    mkdirp: async () => {},
    listDir: (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const first = key.slice(prefix.length).split("/")[0];
        if (first) names.add(first);
      }
      return [...names];
    },
    statMtimeMs: (path) => mtimes.get(path) ?? (fileExists(path) ? 500_000 : null),
    fetchUrl: async (url) => config.fetch?.(url, nowMs) ?? null,
    isBlankImage: async (path) => ({
      blank: config.blankImage?.(path) ?? false,
      method: "size-heuristic",
      detail: "fake",
    }),
    ephemeralPort: async () => nextPort++,
    homeDir: () => "/home/tester",
    sleep: async (ms) => {
      nowMs += ms;
    },
    now: () => nowMs,
    calls,
    launches,
    written,
    clock: () => nowMs,
  };
  return exec;
}
