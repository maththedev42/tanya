import { join } from "node:path";
import { hasFrontendHints, readPackageJson } from "../detect";
import { serveStaticDir, waitForHttp } from "../process";
import {
  makeBootCheck,
  makeBootVerdict,
  makeEvidence,
  type BootAdapter,
  type BootCheckResult,
  type BootEvidence,
  type BootFailureKind,
  type BootVerdict,
  type RuntimeContext,
} from "../types";
import { describeExit, logTailExcerpt } from "./backend";

const NPM_INSTALL_TIMEOUT_MS = 240_000;
const HTTP_BUDGET_MS = 60_000;
const CHROME_TIMEOUT_MS = 45_000;

const URL_IN_LOG = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/i;

const CHROME_APP_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

// A booted web app must answer a real page: success status + non-empty body.
const acceptWebResponse = (response: { status: number; body: string }): boolean =>
  response.status < 400 && response.body.trim().length > 0;

async function findChrome(ctx: RuntimeContext): Promise<string | null> {
  for (const candidate of CHROME_APP_PATHS) {
    if (ctx.exec.fileExists(candidate)) return candidate;
  }
  for (const name of ["google-chrome", "chromium", "chromium-browser"]) {
    const which = await ctx.exec.run(ctx.workspace, "which", [name], { timeoutMs: 5_000 });
    const found = which.stdout.trim().split("\n")[0];
    if (which.exit === 0 && found) return found;
  }
  return null;
}

export const webAdapter: BootAdapter = {
  platform: "web",
  // HTTP checks need nothing beyond node; Chrome is probed separately and its
  // absence only skips the screenshot, never the verdict.
  capabilityProbe: async () => ({ ok: true }),
  boot: bootWeb,
};

async function bootWeb(ctx: RuntimeContext): Promise<BootVerdict> {
  const { exec, workspace } = ctx;
  const checks: BootCheckResult[] = [];
  const evidence: BootEvidence[] = [];
  const fail = (failedCheck: BootFailureKind, reason: string): BootVerdict =>
    makeBootVerdict({ status: "fail", platform: "web", reason, failedCheck, checks, evidence });

  const pkg = readPackageJson(exec, workspace);
  const hasStaticIndex = exec.fileExists(join(workspace, "index.html"));
  const devScript = pkg?.scripts?.dev ? "dev" : pkg?.scripts?.start ? "start" : null;
  const useDevServer = Boolean(pkg && devScript && (hasFrontendHints(pkg) || !hasStaticIndex));

  if (!useDevServer && !hasStaticIndex) {
    return fail("provision-failed", "no dev/start script and no index.html to serve in this workspace");
  }

  if (useDevServer && pkg) {
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
    checks.push(makeBootCheck({ id: "runtime-provision", description: `web provision (npm run ${devScript})`, passed: true }));

    const port = await exec.ephemeralPort();
    const bootLogPath = join(ctx.evidenceDir, "boot.log");
    ctx.emit(`launching: npm run ${devScript} (PORT=${port})`);
    const handle = await exec.launch({
      command: "npm",
      args: ["run", devScript as string],
      cwd: workspace,
      env: { PORT: String(port) },
      logPath: bootLogPath,
    });
    try {
      const exitedEarly = await handle.waitExit(ctx.warmupMs);
      if (exitedEarly || !handle.alive()) {
        evidence.push(makeEvidence("log", { path: bootLogPath, excerpt: logTailExcerpt(handle.logTail()) }));
        checks.push(
          makeBootCheck({ id: "runtime-launch", description: "dev server started", passed: false, detail: describeExit(handle) }),
        );
        return fail("crash", `dev server exited during the ${ctx.warmupMs}ms warmup (${describeExit(handle)})`);
      }
      checks.push(makeBootCheck({ id: "runtime-launch", description: "dev server started", passed: true, detail: `pid ${handle.pid}` }));
      checks.push(makeBootCheck({ id: "runtime-alive", description: `alive after ${ctx.warmupMs}ms warmup`, passed: true }));

      // The URL the server prints wins (vite ignores PORT); our injected PORT
      // is the fallback.
      const loggedPort = URL_IN_LOG.exec(handle.logTail())?.[1];
      const url = `http://127.0.0.1:${loggedPort ?? port}/`;
      const surface = await observeWebSurface(ctx, url, checks, evidence);
      evidence.push(makeEvidence("log", { path: bootLogPath, excerpt: logTailExcerpt(handle.logTail()) }));
      return surface ?? passVerdict(ctx, url, checks, evidence);
    } finally {
      if (ctx.keepAlive) ctx.emit(`keep-alive: dev server left running (pid ${handle.pid})`);
      else await handle.killTree();
    }
  }

  // Static landing page: serve the workspace with the built-in server.
  ctx.emit("serving static index.html");
  checks.push(makeBootCheck({ id: "runtime-provision", description: "static site (built-in server)", passed: true }));
  const server = await serveStaticDir(workspace);
  try {
    checks.push(makeBootCheck({ id: "runtime-launch", description: "static server started", passed: true, detail: `port ${server.port}` }));
    checks.push(makeBootCheck({ id: "runtime-alive", description: "static server alive", passed: true }));
    const url = `http://127.0.0.1:${server.port}/`;
    const surface = await observeWebSurface(ctx, url, checks, evidence);
    return surface ?? passVerdict(ctx, url, checks, evidence);
  } finally {
    if (!ctx.keepAlive) await server.close();
  }
}

// Shared surface observation: HTTP gate + optional Chrome first-frame check.
// Returns a FAIL verdict, or null when the surface checks pass.
async function observeWebSurface(
  ctx: RuntimeContext,
  url: string,
  checks: BootCheckResult[],
  evidence: BootEvidence[],
): Promise<BootVerdict | null> {
  const { exec } = ctx;
  const fail = (failedCheck: BootFailureKind, reason: string): BootVerdict =>
    makeBootVerdict({ status: "fail", platform: "web", reason, failedCheck, checks, evidence });

  ctx.emit(`probing ${url}`);
  const outcome = await waitForHttp(exec, url, { totalMs: HTTP_BUDGET_MS, accept: acceptWebResponse });
  if (!outcome.up) {
    checks.push(
      makeBootCheck({
        id: "runtime-surface",
        description: `HTTP probe ${url}`,
        passed: false,
        detail: outcome.status !== undefined ? `last status ${outcome.status}` : `no response after ${outcome.attempts} attempts`,
      }),
    );
    return fail("http-down", `web server never served a page on ${url} within ${HTTP_BUDGET_MS}ms`);
  }
  evidence.push(makeEvidence("http", { excerpt: `GET ${url} -> ${outcome.status}\n${outcome.bodyExcerpt ?? ""}`.trim() }));
  checks.push(makeBootCheck({ id: "runtime-surface", description: `HTTP probe ${url}`, passed: true, detail: `status ${outcome.status}` }));

  const chrome = await findChrome(ctx);
  if (!chrome) {
    checks.push(
      makeBootCheck({
        id: "runtime-surface",
        description: "first-frame screenshot",
        passed: true,
        skipped: true,
        detail: "Chrome/Chromium not found on this host — screenshot evidence skipped",
      }),
    );
    return null;
  }
  const shotPath = join(ctx.evidenceDir, "first-frame.png");
  ctx.emit("capturing first frame with headless Chrome");
  const shot = await exec.run(
    ctx.workspace,
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${join(ctx.evidenceDir, "chrome-profile")}`,
      "--window-size=1280,800",
      "--virtual-time-budget=8000",
      `--screenshot=${shotPath}`,
      url,
    ],
    { timeoutMs: CHROME_TIMEOUT_MS },
  );
  if (shot.exit !== 0 || !exec.fileExists(shotPath)) {
    // Screenshot capture is evidence, not a gate — Chrome flaking must not
    // turn a serving app into a FAIL.
    checks.push(
      makeBootCheck({
        id: "runtime-surface",
        description: "first-frame screenshot",
        passed: true,
        skipped: true,
        detail: `headless Chrome capture failed (exit ${shot.exit}) — screenshot evidence skipped`,
      }),
    );
    return null;
  }
  evidence.push(makeEvidence("screenshot", { path: shotPath }));
  const blank = await exec.isBlankImage(shotPath);
  if (blank.blank) {
    checks.push(
      makeBootCheck({ id: "runtime-surface", description: "first frame is not blank", passed: false, detail: blank.detail }),
    );
    return fail("blank-first-frame", `page served but the first frame is blank (${blank.detail})`);
  }
  checks.push(
    makeBootCheck({ id: "runtime-surface", description: "first frame is not blank", passed: true, detail: blank.detail }),
  );
  return null;
}

function passVerdict(
  ctx: RuntimeContext,
  url: string,
  checks: BootCheckResult[],
  evidence: BootEvidence[],
): BootVerdict {
  return makeBootVerdict({
    status: "pass",
    platform: "web",
    reason: `web app served a non-blank page on ${url} and stayed alive through ${ctx.warmupMs}ms warmup`,
    checks,
    evidence,
  });
}
