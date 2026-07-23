import { join } from "node:path";
import { readPackageJson, type PackageJsonSummary } from "../detect";
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
import { logTailExcerpt } from "./backend";

const NPM_INSTALL_TIMEOUT_MS = 240_000;
const BUILD_TIMEOUT_MS = 240_000;
const RUN_TIMEOUT_MS = 45_000;

export const scriptAdapter: BootAdapter = {
  platform: "script",
  // We are node; a node CLI is always runnable on this host.
  capabilityProbe: async () => ({ ok: true }),
  boot: bootScript,
};

function resolveBinEntry(pkg: PackageJsonSummary): string | null {
  if (typeof pkg.bin === "string" && pkg.bin.trim()) return pkg.bin.trim();
  if (pkg.bin && typeof pkg.bin === "object") {
    const first = Object.values(pkg.bin).find((value) => typeof value === "string" && value.trim());
    if (first) return first.trim();
  }
  return pkg.main?.trim() || null;
}

// Run-to-completion boot: a CLI's "first surface" is its --help/--version
// output. Pass = one of them exits 0 with non-empty output.
async function bootScript(ctx: RuntimeContext): Promise<BootVerdict> {
  const { exec, workspace } = ctx;
  const checks: BootCheckResult[] = [];
  const evidence: BootEvidence[] = [];
  const fail = (failedCheck: BootFailureKind, reason: string): BootVerdict =>
    makeBootVerdict({ status: "fail", platform: "script", reason, failedCheck, checks, evidence });

  const pkg = readPackageJson(exec, workspace);
  if (!pkg) return fail("provision-failed", "no package.json in this workspace");
  const binRelative = resolveBinEntry(pkg);
  if (!binRelative) return fail("provision-failed", "package.json has no bin or main entry to run");

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

  const binPath = join(workspace, binRelative);
  if (!exec.fileExists(binPath) && pkg.scripts?.build) {
    ctx.emit(`npm run build (${binRelative} missing)`);
    const build = await exec.run(workspace, "npm", ["run", "build"], { timeoutMs: BUILD_TIMEOUT_MS });
    if (build.exit !== 0) {
      const excerpt = logTailExcerpt(`${build.stdout}\n${build.stderr}`);
      evidence.push(makeEvidence("log", { excerpt }));
      checks.push(makeBootCheck({ id: "runtime-provision", description: "npm run build", passed: false, detail: excerpt }));
      return fail(build.timedOut ? "timeout" : "provision-failed", "npm run build failed");
    }
  }
  if (!exec.fileExists(binPath)) {
    checks.push(
      makeBootCheck({ id: "runtime-provision", description: `bin target ${binRelative}`, passed: false, detail: "file not found" }),
    );
    return fail("provision-failed", `bin target ${binRelative} does not exist (no build script produced it)`);
  }
  checks.push(makeBootCheck({ id: "runtime-provision", description: `bin target ${binRelative}`, passed: true }));

  const outputLogPath = join(ctx.evidenceDir, "cli-output.log");
  let lastDetail = "";
  let lastTimedOut = false;
  for (const probeArgs of [["--help"], ["--version"]]) {
    ctx.emit(`running: node ${binRelative} ${probeArgs.join(" ")}`);
    const result = await exec.run(workspace, "node", [binPath, ...probeArgs], { timeoutMs: RUN_TIMEOUT_MS });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    try {
      await exec.writeFile(outputLogPath, `$ node ${binRelative} ${probeArgs.join(" ")}\n${output}\n`);
    } catch {
      // Evidence is best-effort.
    }
    if (result.exit === 0 && output.length > 0) {
      checks.push(
        makeBootCheck({ id: "runtime-launch", description: `node ${binRelative} ${probeArgs.join(" ")}`, passed: true }),
      );
      checks.push(makeBootCheck({ id: "runtime-alive", description: "exited cleanly (code 0)", passed: true }));
      checks.push(
        makeBootCheck({
          id: "runtime-surface",
          description: "produced non-empty output",
          passed: true,
          detail: logTailExcerpt(output).slice(0, 200),
        }),
      );
      evidence.push(makeEvidence("log", { path: outputLogPath, excerpt: logTailExcerpt(output) }));
      return makeBootVerdict({
        status: "pass",
        platform: "script",
        reason: `CLI ran ${binRelative} ${probeArgs.join(" ")}: exit 0 with output`,
        checks,
        evidence,
      });
    }
    lastTimedOut = Boolean(result.timedOut);
    lastDetail = result.timedOut
      ? `timed out after ${RUN_TIMEOUT_MS}ms`
      : output.length === 0
        ? `exit ${result.exit} with no output`
        : `exit ${result.exit}: ${logTailExcerpt(output).slice(0, 300)}`;
  }

  evidence.push(makeEvidence("log", { path: outputLogPath, excerpt: lastDetail }));
  checks.push(
    makeBootCheck({ id: "runtime-launch", description: `node ${binRelative} --help/--version`, passed: false, detail: lastDetail }),
  );
  return fail(
    lastTimedOut ? "timeout" : "nonzero-exit",
    `CLI failed both --help and --version probes (${lastDetail})`,
  );
}
