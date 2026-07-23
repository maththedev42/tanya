// Contract/config validator tools: compare API-contract markdown files and
// sanity-check Android / Apple / fastlane / Prisma project configuration.
// Pure read-only checks — no tool here mutates the workspace.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { TanyaTool } from "./types";
import { resolveInsideWorkspace } from "../safety/workspace";
import { asOptionalNumber, asOptionalString, asRecord, asString, ensureRelativePath } from "./fsTools";

function parseMarkdownApiRoutes(markdown: string): string[] {
  return [...new Set(
    [...markdown.matchAll(/`(?:GET|POST|PUT|PATCH|DELETE)\s+([^`\s]+)`/g)]
      .map((match) => String(match[1] ?? "").trim())
      .filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));
}

export const validateApiContractRoutesTool: TanyaTool = {
  name: "validate_api_contract_routes",
  description: "Compare HTTP route slugs between two markdown API contract files inside the workspace.",
  definition: {
    type: "function",
    function: {
      name: "validate_api_contract_routes",
      description: "Compare HTTP route slugs between two markdown API contract files. Useful for backend/API_FEATURES.md vs brand/api_features.md.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Canonical markdown contract path relative to the workspace." },
          target: { type: "string", description: "Generated markdown contract path relative to the workspace." },
        },
        required: ["source", "target"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const source = ensureRelativePath(asString(input, "source"));
    const target = ensureRelativePath(asString(input, "target"));
    const sourceText = await readFile(resolveInsideWorkspace(context.workspace, source), "utf8");
    const targetText = await readFile(resolveInsideWorkspace(context.workspace, target), "utf8");
    const sourceRoutes = parseMarkdownApiRoutes(sourceText);
    const targetRoutes = parseMarkdownApiRoutes(targetText);
    const missing = sourceRoutes.filter((route) => !targetRoutes.includes(route));
    const extra = targetRoutes.filter((route) => !sourceRoutes.includes(route));
    const ok = missing.length === 0 && extra.length === 0;
    return {
      ok,
      summary: ok
        ? `API route contracts match (${sourceRoutes.length} route${sourceRoutes.length === 1 ? "" : "s"}).`
        : `API route contract mismatch: ${missing.length} missing, ${extra.length} extra.`,
      output: { source, target, sourceRoutes, targetRoutes, missing, extra },
      ...(ok ? {} : { error: `Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}.` }),
    };
  },
};

function numberFromGradle(text: string, name: string): number | null {
  const match = new RegExp(`${name}\\s*(?:=|\\()\\s*(\\d+)`, "m").exec(text);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

export const validateAndroidProjectConfigTool: TanyaTool = {
  name: "validate_android_project_config",
  description: "Validate Android Manifest launcher icon references and Gradle SDK levels.",
  definition: {
    type: "function",
    function: {
      name: "validate_android_project_config",
      description: "Validate AndroidManifest.xml launcher icon references and build.gradle(.kts) SDK levels.",
      parameters: {
        type: "object",
        properties: {
          manifestPath: { type: "string", description: "AndroidManifest.xml path relative to the workspace." },
          gradlePath: { type: "string", description: "Module build.gradle or build.gradle.kts path relative to the workspace." },
          minCompileSdk: { type: "number", description: "Minimum compileSdk. Default 35." },
          minTargetSdk: { type: "number", description: "Minimum targetSdk. Default 35." },
          minSdk: { type: "number", description: "Minimum minSdk. Default 26." },
          expectedIcon: { type: "string", description: "Expected android:icon value. Default @mipmap/ic_launcher." },
          expectedRoundIcon: { type: "string", description: "Expected android:roundIcon value. Default @mipmap/ic_launcher_round." },
        },
        required: ["manifestPath", "gradlePath"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const manifestPath = ensureRelativePath(asString(input, "manifestPath"));
    const gradlePath = ensureRelativePath(asString(input, "gradlePath"));
    const minCompileSdk = asOptionalNumber(input, "minCompileSdk", 35);
    const minTargetSdk = asOptionalNumber(input, "minTargetSdk", 35);
    const minSdk = asOptionalNumber(input, "minSdk", 26);
    const expectedIcon = asOptionalString(input, "expectedIcon") ?? "@mipmap/ic_launcher";
    const expectedRoundIcon = asOptionalString(input, "expectedRoundIcon") ?? "@mipmap/ic_launcher_round";
    const manifest = await readFile(resolveInsideWorkspace(context.workspace, manifestPath), "utf8");
    const gradle = await readFile(resolveInsideWorkspace(context.workspace, gradlePath), "utf8");
    const problems: string[] = [];

    if (!new RegExp(`android:icon=["']${expectedIcon.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(manifest)) {
      problems.push(`Manifest android:icon must be ${expectedIcon}.`);
    }
    if (!new RegExp(`android:roundIcon=["']${expectedRoundIcon.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(manifest)) {
      problems.push(`Manifest android:roundIcon must be ${expectedRoundIcon}.`);
    }

    const compileSdk = numberFromGradle(gradle, "compileSdk");
    const targetSdk = numberFromGradle(gradle, "targetSdk");
    const parsedMinSdk = numberFromGradle(gradle, "minSdk");
    if (compileSdk === null || compileSdk < minCompileSdk) problems.push(`compileSdk must be >= ${minCompileSdk}.`);
    if (targetSdk === null || targetSdk < minTargetSdk) problems.push(`targetSdk must be >= ${minTargetSdk}.`);
    if (parsedMinSdk === null || parsedMinSdk < minSdk) problems.push(`minSdk must be >= ${minSdk}.`);

    return {
      ok: problems.length === 0,
      summary: problems.length === 0 ? "Android project config validated." : `Android project config has ${problems.length} problem${problems.length === 1 ? "" : "s"}.`,
      output: { manifestPath, gradlePath, compileSdk, targetSdk, minSdk: parsedMinSdk, problems },
      ...(problems.length > 0 ? { error: problems.join("; ") } : {}),
    };
  },
};

export const validateAppleProjectFilesTool: TanyaTool = {
  name: "validate_apple_project_files",
  description: "Validate basic Apple/Xcode project file presence and optional pbxproj references.",
  definition: {
    type: "function",
    function: {
      name: "validate_apple_project_files",
      description: "Validate Xcode project presence, required files/assets, and optional project.pbxproj references.",
      parameters: {
        type: "object",
        properties: {
          xcodeprojPath: { type: "string", description: "Optional .xcodeproj directory relative to the workspace." },
          requiredPaths: { type: "array", items: { type: "string" }, description: "Files or directories that must exist relative to the workspace." },
          requireProjectReferences: { type: "boolean", description: "Check project.pbxproj contains each required path basename. Default false." },
        },
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const record = asRecord(input);
    const xcodeprojPath = asOptionalString(input, "xcodeprojPath");
    const requiredPaths = Array.isArray(record.requiredPaths)
      ? record.requiredPaths.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const requireProjectReferences = record.requireProjectReferences === true;
    const problems: string[] = [];
    let pbxprojText = "";

    if (xcodeprojPath) {
      const projectDir = resolveInsideWorkspace(context.workspace, ensureRelativePath(xcodeprojPath));
      if (!existsSync(projectDir)) {
        problems.push(`Missing ${xcodeprojPath}.`);
      } else {
        const pbxprojPath = resolveInsideWorkspace(context.workspace, `${xcodeprojPath.replace(/\/+$/, "")}/project.pbxproj`);
        if (existsSync(pbxprojPath)) pbxprojText = await readFile(pbxprojPath, "utf8");
      }
    }

    for (const requiredPath of requiredPaths) {
      const relPath = ensureRelativePath(requiredPath);
      if (!existsSync(resolveInsideWorkspace(context.workspace, relPath))) {
        problems.push(`Missing ${relPath}.`);
      }
      if (requireProjectReferences && pbxprojText) {
        const basename = relPath.split("/").filter(Boolean).pop() ?? relPath;
        if (!pbxprojText.includes(basename)) problems.push(`project.pbxproj does not reference ${basename}.`);
      }
    }

    return {
      ok: problems.length === 0,
      summary: problems.length === 0 ? "Apple project files validated." : `Apple project validation found ${problems.length} problem${problems.length === 1 ? "" : "s"}.`,
      output: { xcodeprojPath, requiredPaths, problems },
      ...(problems.length > 0 ? { error: problems.join("; ") } : {}),
    };
  },
};

export const validateFastlaneConfigTool: TanyaTool = {
  name: "validate_fastlane_config",
  description: "Validate Fastlane files, required lanes, required files, and optional forbidden files.",
  definition: {
    type: "function",
    function: {
      name: "validate_fastlane_config",
      description: "Validate a Fastlane setup by inspecting Fastfile lane names, required files, and forbidden files such as Gemfile.",
      parameters: {
        type: "object",
        properties: {
          fastfilePath: { type: "string", description: "Fastfile path relative to the workspace. Default fastlane/Fastfile." },
          requiredLanes: { type: "array", items: { type: "string" }, description: "Lane names that must exist, without the lane : prefix." },
          requiredFiles: { type: "array", items: { type: "string" }, description: "Files that must exist relative to the workspace." },
          forbiddenFiles: { type: "array", items: { type: "string" }, description: "Files that must not exist relative to the workspace." },
          requireProjectDirAnchoredToDirname: { type: "boolean", description: "Require File.expand_path(\"..\", __dir__) in Fastfile. Default false." },
        },
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const record = asRecord(input);
    const fastfilePath = asOptionalString(input, "fastfilePath") ?? "fastlane/Fastfile";
    const requiredLanes = Array.isArray(record.requiredLanes)
      ? record.requiredLanes.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
      : [];
    const requiredFiles = Array.isArray(record.requiredFiles)
      ? record.requiredFiles.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
      : [];
    const forbiddenFiles = Array.isArray(record.forbiddenFiles)
      ? record.forbiddenFiles.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim())
      : [];
    const requireProjectDirAnchoredToDirname = record.requireProjectDirAnchoredToDirname === true;
    const problems: string[] = [];
    let fastfile = "";

    const fastfileRel = ensureRelativePath(fastfilePath);
    const fastfileAbs = resolveInsideWorkspace(context.workspace, fastfileRel);
    if (!existsSync(fastfileAbs)) {
      problems.push(`Missing ${fastfileRel}.`);
    } else {
      fastfile = await readFile(fastfileAbs, "utf8");
    }

    const lanes = [...new Set([...fastfile.matchAll(/^\s*lane\s+:([A-Za-z0-9_]+)\s+do\b/gm)].map((match) => String(match[1] ?? "")))].sort();
    const platformLanes: string[] = [];
    let currentPlatform: string | null = null;
    for (const line of fastfile.split(/\r?\n/)) {
      const platformMatch = /^\s*platform\s+:([A-Za-z0-9_]+)\s+do\b/.exec(line);
      if (platformMatch) currentPlatform = platformMatch[1] ?? null;
      const laneMatch = /^\s*lane\s+:([A-Za-z0-9_]+)\s+do\b/.exec(line);
      if (currentPlatform && laneMatch?.[1]) platformLanes.push(`${currentPlatform} ${laneMatch[1]}`);
    }
    platformLanes.sort();
    for (const lane of requiredLanes) {
      const normalized = lane.replace(/^:/, "").replace(/[:.]/g, " ").replace(/\s+/g, " ").trim();
      if (normalized.includes(" ")) {
        if (!platformLanes.includes(normalized)) problems.push(`Missing Fastlane platform lane ${normalized}.`);
      } else if (!lanes.includes(normalized)) {
        problems.push(`Missing Fastlane lane :${normalized}.`);
      }
    }
    if (requiredLanes.map((lane) => lane.replace(/^:/, "").trim()).includes("bump")) {
      const lines = fastfile.split(/\r?\n/);
      const bumpIndex = lines.findIndex((line) => /^\s*lane\s+:bump\s+do\b/.test(line));
      if (bumpIndex >= 0) {
        const firstBodyLine = lines.slice(bumpIndex + 1).find((line) => line.trim() && !line.trim().startsWith("#"))?.trim() ?? "";
        if (/^if\s+options\[:version\]/.test(firstBodyLine)) {
          problems.push("Fastlane lane :bump must increment versionCode by default; options[:version] may only control versionName.");
        }
      }
    }
    if (requireProjectDirAnchoredToDirname && !fastfile.includes('File.expand_path("..", __dir__)')) {
      problems.push('Fastfile must anchor Gradle project_dir with File.expand_path("..", __dir__).');
    }
    for (const file of requiredFiles) {
      const relPath = ensureRelativePath(file);
      if (!existsSync(resolveInsideWorkspace(context.workspace, relPath))) problems.push(`Missing ${relPath}.`);
    }
    for (const file of forbiddenFiles) {
      const relPath = ensureRelativePath(file);
      if (existsSync(resolveInsideWorkspace(context.workspace, relPath))) problems.push(`Forbidden file exists: ${relPath}.`);
    }

    return {
      ok: problems.length === 0,
      summary: problems.length === 0 ? `Fastlane config validated (${lanes.length} lane${lanes.length === 1 ? "" : "s"}).` : `Fastlane config has ${problems.length} problem${problems.length === 1 ? "" : "s"}.`,
      output: { fastfilePath: fastfileRel, lanes, platformLanes, requiredLanes, requiredFiles, forbiddenFiles, problems },
      ...(problems.length > 0 ? { error: problems.join("; ") } : {}),
    };
  },
};

export const validatePrismaSchemaTool: TanyaTool = {
  name: "validate_prisma_schema",
  description: "Validate Prisma schema model presence and forbidden drift names.",
  definition: {
    type: "function",
    function: {
      name: "validate_prisma_schema",
      description: "Validate required and forbidden Prisma model names in schema.prisma.",
      parameters: {
        type: "object",
        properties: {
          schemaPath: { type: "string", description: "Prisma schema path relative to the workspace. Default prisma/schema.prisma." },
          requiredModels: { type: "array", items: { type: "string" }, description: "Model names that must exist." },
          forbiddenModels: { type: "array", items: { type: "string" }, description: "Model names that must not exist." },
        },
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const record = asRecord(input);
    const schemaPath = ensureRelativePath(asOptionalString(input, "schemaPath") ?? "prisma/schema.prisma");
    const requiredModels = Array.isArray(record.requiredModels)
      ? record.requiredModels.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const forbiddenModels = Array.isArray(record.forbiddenModels)
      ? record.forbiddenModels.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const schema = await readFile(resolveInsideWorkspace(context.workspace, schemaPath), "utf8");
    const models = [...schema.matchAll(/^\s*model\s+([A-Za-z][A-Za-z0-9_]*)\s*\{/gm)].map((match) => String(match[1]));
    const problems: string[] = [];
    for (const model of requiredModels) if (!models.includes(model)) problems.push(`Missing model ${model}.`);
    for (const model of forbiddenModels) if (models.includes(model)) problems.push(`Forbidden model ${model} is present.`);
    const openModelBlocks = (schema.match(/\bmodel\s+[A-Za-z][A-Za-z0-9_]*\s*\{/g) ?? []).length;
    const closeBraces = (schema.match(/\}/g) ?? []).length;
    if (closeBraces < openModelBlocks) problems.push("Schema appears to have an unclosed model block.");

    return {
      ok: problems.length === 0,
      summary: problems.length === 0 ? `Prisma schema validated (${models.length} model${models.length === 1 ? "" : "s"}).` : `Prisma schema has ${problems.length} problem${problems.length === 1 ? "" : "s"}.`,
      output: { schemaPath, models, problems },
      ...(problems.length > 0 ? { error: problems.join("; ") } : {}),
    };
  },
};
