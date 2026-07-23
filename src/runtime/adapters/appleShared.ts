import { join } from "node:path";
import type { RuntimeContext, RuntimeExec } from "../types";
import { logTailExcerpt } from "./backend";

export const XCODEGEN_TIMEOUT_MS = 120_000;
export const XCODEBUILD_TIMEOUT_MS = 300_000;

export function hasProjectYml(exec: RuntimeExec, workspace: string): boolean {
  return exec.fileExists(join(workspace, "project.yml"));
}

// Capability side of the xcodegen rule: a project.yml workspace cannot be
// built on a host without xcodegen — that's a SKIP, not a failure.
export async function xcodegenCapabilityGap(ctx: RuntimeContext): Promise<string | null> {
  if (!hasProjectYml(ctx.exec, ctx.workspace)) return null;
  const which = await ctx.exec.run(ctx.workspace, "which", ["xcodegen"], { timeoutMs: 10_000 });
  if (which.exit !== 0 || !which.stdout.trim()) {
    return "project.yml present but xcodegen is not installed on this host";
  }
  return null;
}

// The locked gotcha: a stale .xcodeproj after new Swift files were added makes
// xcodebuild fail with "cannot find X in scope". Whenever project.yml exists,
// regenerate before any xcodebuild.
export async function runXcodegenIfNeeded(ctx: RuntimeContext): Promise<{ ok: boolean; detail: string }> {
  if (!hasProjectYml(ctx.exec, ctx.workspace)) return { ok: true, detail: "no project.yml" };
  ctx.emit("xcodegen generate (project.yml present)");
  const result = await ctx.exec.run(ctx.workspace, "xcodegen", ["generate"], { timeoutMs: XCODEGEN_TIMEOUT_MS });
  if (result.exit !== 0) {
    return { ok: false, detail: logTailExcerpt(`${result.stdout}\n${result.stderr}`) };
  }
  return { ok: true, detail: "xcodegen generate" };
}

export function xcodeContainerArgs(exec: RuntimeExec, workspace: string): string[] | null {
  const entries = exec.listDir(workspace);
  const workspaceEntry = entries.find((name) => name.endsWith(".xcworkspace"));
  if (workspaceEntry) return ["-workspace", workspaceEntry];
  const projectEntry = entries.find((name) => name.endsWith(".xcodeproj"));
  if (projectEntry) return ["-project", projectEntry];
  return null;
}

export async function firstScheme(ctx: RuntimeContext, containerArgs: string[]): Promise<string | null> {
  const list = await ctx.exec.run(ctx.workspace, "xcodebuild", [...containerArgs, "-list", "-json"], {
    timeoutMs: 60_000,
  });
  if (list.exit !== 0) return null;
  try {
    const parsed = JSON.parse(list.stdout) as {
      project?: { schemes?: string[] };
      workspace?: { schemes?: string[] };
    };
    return parsed.project?.schemes?.[0] ?? parsed.workspace?.schemes?.[0] ?? null;
  } catch {
    return null;
  }
}

export function findAppBundle(exec: RuntimeExec, productsDir: string): string | null {
  const app = exec.listDir(productsDir).find((name) => name.endsWith(".app"));
  return app ? join(productsDir, app) : null;
}

export async function readPlistKey(ctx: RuntimeContext, plistPath: string, key: string): Promise<string | null> {
  const result = await ctx.exec.run(ctx.workspace, "plutil", ["-extract", key, "raw", plistPath], {
    timeoutMs: 15_000,
  });
  const value = result.stdout.trim();
  return result.exit === 0 && value ? value : null;
}

// Crash reports written for this app since the launch started.
export function newCrashReports(exec: RuntimeExec, appName: string, sinceMs: number): string[] {
  const dir = join(exec.homeDir(), "Library", "Logs", "DiagnosticReports");
  return exec
    .listDir(dir)
    .filter((name) => name.startsWith(appName) && (name.endsWith(".ips") || name.endsWith(".crash")))
    .map((name) => join(dir, name))
    .filter((path) => {
      const mtime = exec.statMtimeMs(path);
      return mtime !== null && mtime >= sinceMs;
    });
}
