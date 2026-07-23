import { join } from "node:path";
import type { RuntimeExec, RuntimePlatform } from "./types";

export type PackageJsonSummary = {
  name?: string;
  version?: string;
  main?: string;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export function readPackageJson(exec: RuntimeExec, workspace: string): PackageJsonSummary | null {
  const raw = exec.readText(join(workspace, "package.json"));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PackageJsonSummary;
  } catch {
    return null;
  }
}

function dependencyNames(pkg: PackageJsonSummary): string[] {
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
}

const FRONTEND_DEP_HINTS = ["next", "vite", "react-scripts", "astro", "svelte", "@remix-run/react", "nuxt", "@angular/core"];
const BACKEND_DEP_HINTS = ["express", "fastify", "@nestjs/core", "hono", "koa", "@hapi/hapi"];

export function hasFrontendHints(pkg: PackageJsonSummary): boolean {
  const deps = dependencyNames(pkg);
  return FRONTEND_DEP_HINTS.some((hint) => deps.includes(hint));
}

export function hasNodeBackendHints(pkg: PackageJsonSummary): boolean {
  const deps = dependencyNames(pkg);
  return BACKEND_DEP_HINTS.some((hint) => deps.includes(hint));
}

// Names that mark the long-running server among multiple cmd/ entries (real
// backends ship batch tools next to the API — alphabetical order would pick
// e.g. ./cmd/build-corpus-rollups over ./cmd/server).
const GO_SERVER_CMD_NAMES = ["server", "api", "serve", "app", "web", "main"];

// The Go main-package directory to boot (workspace-relative; "." for the
// root), or null when the module has no runnable entry point. Prefers
// server-like cmd names, then falls back to the first entry alphabetically.
export function goMainDir(exec: RuntimeExec, workspace: string): string | null {
  if (!exec.fileExists(join(workspace, "go.mod"))) return null;
  if (exec.fileExists(join(workspace, "main.go"))) return ".";
  const cmdDir = join(workspace, "cmd");
  const mains = exec
    .listDir(cmdDir)
    .sort()
    .filter((entry) => exec.fileExists(join(cmdDir, entry, "main.go")));
  if (mains.length === 0) return null;
  const preferred = GO_SERVER_CMD_NAMES.map((name) => mains.find((entry) => entry.toLowerCase().includes(name))).find(
    (entry) => entry !== undefined,
  );
  return `./cmd/${preferred ?? mains[0]}`;
}

export type DetectedPlatform = { platform: RuntimePlatform; evidence: string };

// Order matters: the most specific markers win. iOS/macOS project files beat
// gradle, gradle beats package.json heuristics, frontend deps beat backend
// deps (a Next app with an express dep is still a web app).
export function detectPlatform(exec: RuntimeExec, workspace: string): DetectedPlatform | null {
  const projectYml = join(workspace, "project.yml");
  if (exec.fileExists(projectYml)) {
    const text = exec.readText(projectYml) ?? "";
    if (/platform:\s*macOS/i.test(text) && !/platform:\s*iOS/i.test(text)) {
      return { platform: "macos", evidence: "project.yml (platform: macOS)" };
    }
    return { platform: "ios", evidence: "project.yml" };
  }

  const entries = exec.listDir(workspace);
  const xcodeProject = entries.find((name) => name.endsWith(".xcodeproj"));
  if (xcodeProject) {
    const pbxproj = exec.readText(join(workspace, xcodeProject, "project.pbxproj")) ?? "";
    if (/SDKROOT\s*=\s*macosx/.test(pbxproj) && !/SDKROOT\s*=\s*iphoneos/.test(pbxproj)) {
      return { platform: "macos", evidence: `${xcodeProject} (SDKROOT = macosx)` };
    }
    return { platform: "ios", evidence: xcodeProject };
  }

  if (
    exec.fileExists(join(workspace, "gradlew")) &&
    (exec.fileExists(join(workspace, "settings.gradle")) || exec.fileExists(join(workspace, "settings.gradle.kts")))
  ) {
    return { platform: "android", evidence: "gradlew + settings.gradle" };
  }

  const pkg = readPackageJson(exec, workspace);
  if (pkg && hasFrontendHints(pkg)) {
    return { platform: "web", evidence: "package.json frontend dependencies" };
  }
  if (!pkg && exec.fileExists(join(workspace, "index.html"))) {
    return { platform: "web", evidence: "static index.html" };
  }

  const goDir = goMainDir(exec, workspace);
  if (goDir) {
    return { platform: "backend", evidence: `go.mod (main package at ${goDir})` };
  }
  if (pkg && hasNodeBackendHints(pkg)) {
    return { platform: "backend", evidence: "package.json backend dependencies" };
  }
  if (pkg?.bin && (typeof pkg.bin === "string" || Object.keys(pkg.bin).length > 0)) {
    return { platform: "script", evidence: "package.json bin field" };
  }
  if (pkg && exec.fileExists(join(workspace, "index.html"))) {
    return { platform: "web", evidence: "index.html alongside package.json" };
  }
  if (pkg?.scripts?.start) {
    return { platform: "backend", evidence: "package.json start script" };
  }
  return null;
}
