import { join } from "node:path";
import { goMainDir, readPackageJson } from "../detect";
import { waitForHttp } from "../process";
import {
  makeBootCheck,
  makeBootVerdict,
  makeEvidence,
  type BootAdapter,
  type BootCheckResult,
  type BootEvidence,
  type BootFailureKind,
  type BootVerdict,
  type LaunchHandle,
  type RuntimeContext,
} from "../types";

const NPM_INSTALL_TIMEOUT_MS = 180_000;
const GO_BUILD_TIMEOUT_MS = 120_000;
const HTTP_BUDGET_MS = 30_000;
const LOG_EXCERPT_BYTES = 1_500;

// The booted server's URL/port, as printed by the app itself, is the source
// of truth; the PORT env we inject is the fallback (Tanya-generated backends
// honor it). Apps that bind a silent hardcoded port must print their URL or
// port — covered patterns: plain URLs, "listening on port N", and structured
// JSON logs like {"msg":"starting server","port":"8000"} (slog/zap style).
const URL_IN_LOG = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/i;
const PORT_IN_LOG = /listen(?:ing|s)?(?:\s+on)?(?:\s+port)?\s*:?\s*(\d{2,5})/i;
const PORT_FIELD_IN_LOG = /"(?:port|addr(?:ess)?)"\s*:\s*"?:?(\d{2,5})"?/i;

export function portFromServerLog(log: string): string | null {
  return URL_IN_LOG.exec(log)?.[1] ?? PORT_IN_LOG.exec(log)?.[1] ?? PORT_FIELD_IN_LOG.exec(log)?.[1] ?? null;
}

export function logTailExcerpt(text: string): string {
  return text.slice(-LOG_EXCERPT_BYTES).trim();
}

export function describeExit(handle: LaunchHandle): string {
  const info = handle.exit();
  if (!info) return "still running";
  if (info.signal) return `killed by ${info.signal}`;
  return `exit code ${info.code ?? "unknown"}`;
}

export const backendAdapter: BootAdapter = {
  platform: "backend",
  capabilityProbe: async (ctx) => {
    if (goMainDir(ctx.exec, ctx.workspace)) {
      const probe = await ctx.exec.run(ctx.workspace, "go", ["version"], { timeoutMs: 15_000 });
      if (probe.binaryMissing || probe.exit !== 0) {
        return { ok: false, reason: "go toolchain not available on this host" };
      }
    }
    return { ok: true };
  },
  boot: bootBackend,
};

async function bootBackend(ctx: RuntimeContext): Promise<BootVerdict> {
  const { exec, workspace } = ctx;
  const checks: BootCheckResult[] = [];
  const evidence: BootEvidence[] = [];
  const bootLogPath = join(ctx.evidenceDir, "boot.log");
  const fail = (failedCheck: BootFailureKind, reason: string): BootVerdict =>
    makeBootVerdict({ status: "fail", platform: "backend", reason, failedCheck, checks, evidence });

  // ── provision ────────────────────────────────────────────
  let command: string;
  let args: string[];
  const goDir = goMainDir(exec, workspace);
  if (goDir) {
    const binaryPath = join(ctx.evidenceDir, "server");
    ctx.emit(`go build ${goDir}`);
    const build = await exec.run(workspace, "go", ["build", "-o", binaryPath, goDir], {
      timeoutMs: GO_BUILD_TIMEOUT_MS,
    });
    if (build.exit !== 0) {
      const excerpt = logTailExcerpt(`${build.stdout}\n${build.stderr}`);
      evidence.push(makeEvidence("log", { excerpt }));
      checks.push(makeBootCheck({ id: "runtime-provision", description: `go build ${goDir}`, passed: false, detail: excerpt }));
      return fail(build.timedOut ? "timeout" : "provision-failed", "go build failed");
    }
    checks.push(makeBootCheck({ id: "runtime-provision", description: `go build ${goDir}`, passed: true }));
    command = binaryPath;
    args = [];
  } else {
    const pkg = readPackageJson(exec, workspace);
    if (!pkg) return fail("provision-failed", "no go main package or package.json in this workspace");
    if (!exec.fileExists(join(workspace, "node_modules")) && (pkg.dependencies || pkg.devDependencies)) {
      ctx.emit("npm install (node_modules missing)");
      const install = await exec.run(workspace, "npm", ["install", "--no-audit", "--no-fund"], {
        timeoutMs: NPM_INSTALL_TIMEOUT_MS,
      });
      if (install.exit !== 0) {
        const excerpt = logTailExcerpt(`${install.stdout}\n${install.stderr}`);
        evidence.push(makeEvidence("log", { excerpt }));
        checks.push(makeBootCheck({ id: "runtime-provision", description: "npm install", passed: false, detail: excerpt }));
        return fail(install.timedOut ? "timeout" : "provision-failed", "npm install failed");
      }
    }
    if (pkg.scripts?.start) {
      command = "npm";
      args = ["start"];
    } else if (pkg.main) {
      command = "node";
      args = [pkg.main];
    } else if (exec.fileExists(join(workspace, "index.js"))) {
      command = "node";
      args = ["index.js"];
    } else {
      return fail("provision-failed", "package.json has no start script or main entry to launch");
    }
    checks.push(makeBootCheck({ id: "runtime-provision", description: "node server provision", passed: true }));
  }

  // ── launch + observe ─────────────────────────────────────
  const port = await exec.ephemeralPort();
  ctx.emit(`launching: ${command} ${args.join(" ")} (PORT=${port})`);
  const handle = await exec.launch({
    command,
    args,
    cwd: workspace,
    env: { PORT: String(port) },
    logPath: bootLogPath,
  });

  try {
    const exitedEarly = await handle.waitExit(ctx.warmupMs);
    if (exitedEarly || !handle.alive()) {
      evidence.push(makeEvidence("log", { path: bootLogPath, excerpt: logTailExcerpt(handle.logTail()) }));
      checks.push(
        makeBootCheck({ id: "runtime-launch", description: "server process started", passed: false, detail: describeExit(handle) }),
      );
      return fail("crash", `server exited during the ${ctx.warmupMs}ms warmup (${describeExit(handle)})`);
    }
    checks.push(makeBootCheck({ id: "runtime-launch", description: "server process started", passed: true, detail: `pid ${handle.pid}` }));
    checks.push(makeBootCheck({ id: "runtime-alive", description: `alive after ${ctx.warmupMs}ms warmup`, passed: true }));

    const probePort = portFromServerLog(handle.logTail()) ?? String(port);
    const probeUrl = `http://127.0.0.1:${probePort}/`;
    ctx.emit(`probing ${probeUrl}`);
    const outcome = await waitForHttp(exec, probeUrl, { totalMs: HTTP_BUDGET_MS });
    evidence.push(makeEvidence("log", { path: bootLogPath, excerpt: logTailExcerpt(handle.logTail()) }));
    if (!outcome.up) {
      checks.push(
        makeBootCheck({
          id: "runtime-surface",
          description: `HTTP probe ${probeUrl}`,
          passed: false,
          detail: `no response after ${outcome.attempts} attempts — servers must honor the PORT env var or print their URL/port to stdout`,
        }),
      );
      return fail("http-down", `server process is alive but ${probeUrl} never answered within ${HTTP_BUDGET_MS}ms`);
    }
    evidence.push(
      makeEvidence("http", { excerpt: `GET ${probeUrl} -> ${outcome.status}\n${outcome.bodyExcerpt ?? ""}`.trim() }),
    );
    checks.push(
      makeBootCheck({ id: "runtime-surface", description: `HTTP probe ${probeUrl}`, passed: true, detail: `status ${outcome.status}` }),
    );
    return makeBootVerdict({
      status: "pass",
      platform: "backend",
      reason: `server booted, stayed alive through ${ctx.warmupMs}ms warmup, answered HTTP ${outcome.status} on :${probePort}`,
      checks,
      evidence,
    });
  } finally {
    if (ctx.keepAlive) ctx.emit(`keep-alive: server left running (pid ${handle.pid})`);
    else await handle.killTree();
  }
}
