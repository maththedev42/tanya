// Platform scaffold tools: artifact application, iOS/Android splash screens,
// app icon generation, the Android foundation generator, and the platform
// commit tool. These share no state with the fs primitives in fsTools —
// they consume its exported arg/validation/process helpers only.
import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import sharp from "sharp";
import type { TanyaTool, ToolContext } from "./types";
import { resolveInsideWorkspace } from "../safety/workspace";
import { createAndroidLauncherIconSetTool, createAppleAppIconSetTool, resizeImageTool } from "./imageTools";
import {
  asOptionalBoolean,
  asOptionalNumber,
  asOptionalString,
  asRecord,
  asString,
  ensureRelativePath,
  isProtectedLocalConfigPath,
  localPropertiesWriteError,
  normalizeRelativePathForGit,
  pathExists,
  runProcess,
  withGitLockRetry,
} from "./fsTools";

export const applyArtifactTool: TanyaTool = {
  name: "apply_artifact",
  description: "Copy a materialized artifact file or directory to a target path inside the workspace.",
  definition: {
    type: "function",
    function: {
      name: "apply_artifact",
      description: "Apply a local materialized artifact by copying it to a target path. Use after reading an artifact that should become the starting point for an implementation.",
      parameters: {
        type: "object",
        properties: {
          artifactPath: { type: "string", description: "Materialized artifact path relative to the workspace, for example .tanya/artifacts/ios/Foo.swift." },
          targetPath: { type: "string", description: "Target file or directory path relative to the workspace." },
          overwrite: { type: "boolean", description: "Overwrite target if it exists. Default true." },
        },
        required: ["artifactPath", "targetPath"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const artifactPath = ensureRelativePath(asString(input, "artifactPath"));
    const targetPath = ensureRelativePath(asString(input, "targetPath"));
    if (isProtectedLocalConfigPath(targetPath)) return localPropertiesWriteError();
    const overwrite = asRecord(input).overwrite !== false;
    const sourceAbs = resolveInsideWorkspace(context.workspace, artifactPath);
    const targetAbs = resolveInsideWorkspace(context.workspace, targetPath);
    await mkdir(dirname(targetAbs), { recursive: true });
    await cp(sourceAbs, targetAbs, { recursive: true, force: overwrite, errorOnExist: !overwrite });
    return {
      ok: true,
      summary: `Applied artifact ${artifactPath} to ${targetPath}.`,
      output: { artifactPath, targetPath },
      files: [targetPath],
    };
  },
};

function inferIosSplashAssetSetDir(viewPath: string): string {
  const viewDir = dirname(viewPath).replace(/\\/g, "/");
  return `${viewDir}/Assets.xcassets/SplashIcon.imageset`;
}

async function firstExistingWorkspacePath(context: ToolContext, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const clean = candidate.replace(/\\/g, "/").replace(/^\/+/, "");
    const abs = resolveInsideWorkspace(context.workspace, clean);
    if (await pathExists(abs)) return clean;
  }
  return null;
}

async function findLargestAppIconPng(context: ToolContext, viewPath: string): Promise<string | null> {
  const viewDir = dirname(viewPath).replace(/\\/g, "/");
  const appIconDir = `${viewDir}/Assets.xcassets/AppIcon.appiconset`;
  const appIconAbs = resolveInsideWorkspace(context.workspace, appIconDir);
  if (!existsSync(appIconAbs)) return null;
  const pngs = readdirSync(appIconAbs, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.png$/i.test(entry.name))
    .map((entry) => `${appIconDir}/${entry.name}`);
  if (pngs.length === 0) return null;
  const score = (path: string) => {
    const size = path.match(/(\d{2,4})x\1|-(\d{2,4})\.png|@(\d)x/i);
    return Number(size?.[1] ?? size?.[2] ?? size?.[3] ?? 0);
  };
  return pngs.sort((a, b) => score(b) - score(a))[0] ?? null;
}

async function createFallbackSplashIconPng(destinationAbs: string, brandHex: string, appName: string): Promise<void> {
  const label = appName
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "A";
  const safeLabel = label.replace(/[<>&"]/g, "");
  const safeBrand = /^#[0-9a-f]{6}$/i.test(brandHex) ? brandHex : "#000000";
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">`,
    `<rect width="1024" height="1024" rx="220" fill="${safeBrand}"/>`,
    `<circle cx="512" cy="512" r="312" fill="rgba(0,0,0,0.28)"/>`,
    `<circle cx="512" cy="512" r="244" fill="rgba(255,255,255,0.12)"/>`,
    `<text x="512" y="570" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="260" font-weight="800" fill="#ffffff">${safeLabel}</text>`,
    `</svg>`,
  ].join("");
  await mkdir(dirname(destinationAbs), { recursive: true });
  await sharp(Buffer.from(svg)).png({ force: true }).toFile(destinationAbs);
}

export const createIosSplashTool: TanyaTool = {
  name: "create_ios_splash",
  description: "Create a standard SwiftUI iOS splash view and SplashIcon asset from a source image or deterministic fallback.",
  definition: {
    type: "function",
    function: {
      name: "create_ios_splash",
      description: "Create SplashScreenView.swift and Assets.xcassets/SplashIcon.imageset resources using explicit brand color.",
      parameters: {
        type: "object",
        properties: {
          viewPath: { type: "string", description: "Destination Swift file, for example CosaNostra/SplashScreenView.swift." },
          assetSetDir: { type: "string", description: "Optional SplashIcon.imageset directory relative to workspace. Defaults beside viewPath under Assets.xcassets." },
          sourceIcon: { type: "string", description: "Optional source image path relative to workspace. If omitted, Tanya searches common brand/AppIcon paths, then creates a fallback PNG." },
          appName: { type: "string", description: "Optional app name shown below the icon." },
          brandHex: { type: "string", description: "Brand background color, for example #A52A2A. Default #000000." },
          durationMs: { type: "number", description: "Splash delay in milliseconds. Default 1200." },
        },
        required: ["viewPath"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const viewPath = ensureRelativePath(asString(input, "viewPath"));
    const assetSetDir = (asOptionalString(input, "assetSetDir") ?? inferIosSplashAssetSetDir(viewPath)).replace(/\/+$/, "");
    const sourceIcon = asOptionalString(input, "sourceIcon");
    const appName = asOptionalString(input, "appName") ?? "App";
    const brandHex = asOptionalString(input, "brandHex") ?? "#000000";
    const durationMs = Math.max(0, Math.round(asOptionalNumber(input, "durationMs", 1200)));
    const durationNs = durationMs * 1_000_000;
    const rgb = brandHex.replace("#", "").match(/.{1,2}/g)?.slice(0, 3).map((part) => Number.parseInt(part, 16)) ?? [0, 0, 0];
    const view = [
      "import SwiftUI",
      "",
      "struct SplashScreenView<Content: View>: View {",
      "    @State private var isReady = false",
      "    @State private var iconVisible = false",
      "    let content: () -> Content",
      "",
      "    private let brandColor = Color(",
      `        red: ${rgb[0] ?? 0} / 255,`,
      `        green: ${rgb[1] ?? 0} / 255,`,
      `        blue: ${rgb[2] ?? 0} / 255`,
      "    )",
      "",
      "    var body: some View {",
      "        ZStack {",
      "            if isReady {",
      "                content()",
      "            } else {",
      "                brandColor",
      "                    .ignoresSafeArea()",
      "                    .overlay(",
      "                        Image(\"SplashIcon\")",
      "                            .resizable()",
      "                            .scaledToFit()",
      "                            .frame(width: 120, height: 120)",
      "                            .opacity(iconVisible ? 1 : 0)",
      "                            .animation(.easeOut(duration: 0.6), value: iconVisible)",
      "                            .accessibilityLabel(\"" + appName.replace(/"/g, "\\\"") + "\")",
      "                    )",
      "            }",
      "        }",
      "        .onAppear {",
      "            iconVisible = true",
      "            Task {",
      `                try? await Task.sleep(nanoseconds: ${durationNs})`,
      "                isReady = true",
      "            }",
      "        }",
      "    }",
      "}",
      "",
    ].join("\n");

    const viewAbs = resolveInsideWorkspace(context.workspace, viewPath);
    await mkdir(dirname(viewAbs), { recursive: true });
    await writeFile(viewAbs, view, "utf8");
    const files = [viewPath];

    const cleanAssetSetDir = ensureRelativePath(assetSetDir);
    const iconPath = `${cleanAssetSetDir}/SplashIcon.png`;
    const resolvedSourceIcon = sourceIcon
      ? sourceIcon
      : await firstExistingWorkspacePath(context, [
        "brand/icons/icon-1024.png",
        "brand/icons/ios/AppStore-1024x1024.png",
        ".tanya/context/brand/icons/icon-1024.png",
        ".tanya/context/brand/icons/ios/AppStore-1024x1024.png",
      ]) ?? await findLargestAppIconPng(context, viewPath);

    if (resolvedSourceIcon) {
      const sourceAbs = isAbsolute(resolvedSourceIcon)
        ? resolvedSourceIcon
        : resolveInsideWorkspace(context.workspace, ensureRelativePath(resolvedSourceIcon));
      if (!existsSync(sourceAbs)) {
        return { ok: false, summary: "Source splash icon not found.", error: `Missing source icon: ${resolvedSourceIcon}` };
      }
      await mkdir(dirname(resolveInsideWorkspace(context.workspace, iconPath)), { recursive: true });
      await sharp(sourceAbs)
        .resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toFile(resolveInsideWorkspace(context.workspace, iconPath));
    } else {
      await createFallbackSplashIconPng(resolveInsideWorkspace(context.workspace, iconPath), brandHex, appName);
    }
    const contentsPath = `${cleanAssetSetDir}/Contents.json`;
    await mkdir(dirname(resolveInsideWorkspace(context.workspace, contentsPath)), { recursive: true });
    await writeFile(resolveInsideWorkspace(context.workspace, contentsPath), `${JSON.stringify({
      images: [{ idiom: "universal", filename: "SplashIcon.png", scale: "1x" }],
      info: { author: "xcode", version: 1 },
    }, null, 2)}\n`, "utf8");
    files.push(iconPath, contentsPath);

    return { ok: true, summary: `Created iOS splash view and SplashIcon asset at ${viewPath}.`, output: { viewPath, assetSetDir, sourceIcon: resolvedSourceIcon ?? "generated-fallback", brandHex, durationMs, appName }, files };
  },
};

export const createAndroidSplashTool: TanyaTool = {
  name: "create_android_splash",
  description: "Create Android SplashScreen API resources and optional drawable icon from a source image.",
  definition: {
    type: "function",
    function: {
      name: "create_android_splash",
      description: "Create splash_theme.xml and a drawable PNG for Android SplashScreen API wiring.",
      parameters: {
        type: "object",
        properties: {
          resDir: { type: "string", description: "Android res directory, for example app/src/main/res." },
          sourceIcon: { type: "string", description: "Optional source image path relative to workspace." },
          brandHex: { type: "string", description: "Brand background color. Default #000000." },
          themeName: { type: "string", description: "Splash theme name. Default Theme.App.Starting." },
          iconName: { type: "string", description: "Drawable icon resource name. Default ic_splash_logo." },
        },
        required: ["resDir"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const resDir = ensureRelativePath(asString(input, "resDir")).replace(/\/+$/, "");
    const sourceIcon = asOptionalString(input, "sourceIcon");
    const brandHex = asOptionalString(input, "brandHex") ?? "#000000";
    const themeName = asOptionalString(input, "themeName") ?? "Theme.App.Starting";
    const iconName = (asOptionalString(input, "iconName") ?? "ic_splash_logo").replace(/[^a-z0-9_]/gi, "_").toLowerCase();
    const valuesPath = `${resDir}/values/splash_theme.xml`;
    const drawablePath = `${resDir}/drawable/${iconName}.png`;
    const xml = [
      "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
      "<resources>",
      `    <style name="${themeName}" parent="Theme.SplashScreen">`,
      `        <item name="windowSplashScreenBackground">${brandHex}</item>`,
      `        <item name="windowSplashScreenAnimatedIcon">@drawable/${iconName}</item>`,
      "        <item name=\"postSplashScreenTheme\">@style/Theme.App</item>",
      "    </style>",
      "</resources>",
      "",
    ].join("\n");
    await mkdir(dirname(resolveInsideWorkspace(context.workspace, valuesPath)), { recursive: true });
    await writeFile(resolveInsideWorkspace(context.workspace, valuesPath), xml, "utf8");
    const files = [valuesPath];
    if (sourceIcon) {
      const resizeResult = await resizeImageTool.run(
        { source: ensureRelativePath(sourceIcon), destination: drawablePath, width: 432, height: 432, background: "transparent" },
        context,
      );
      if (!resizeResult.ok) return resizeResult;
      files.push(drawablePath);
    }
    return { ok: true, summary: `Created Android splash resources in ${resDir}.`, output: { resDir, themeName, iconName, brandHex }, files };
  },
};

export const generateAppIconsTool: TanyaTool = {
  name: "generate_app_icons",
  description: "Generate Apple and/or Android app icon resources from one source image.",
  definition: {
    type: "function",
    function: {
      name: "generate_app_icons",
      description: "Generate app icon resources for Apple AppIcon.appiconset and Android launcher icons.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source image path relative to workspace. Prefer 1024x1024 PNG." },
          appleOutputDir: { type: "string", description: "Optional AppIcon.appiconset output directory." },
          applePlatforms: { type: "array", items: { type: "string", enum: ["ios", "macos"] }, description: "Apple platforms. Default ['ios', 'macos']." },
          androidResDir: { type: "string", description: "Optional Android res output directory." },
          background: { type: "string", description: "Background color used to remove alpha. Default #ffffff." },
        },
        required: ["source"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const source = ensureRelativePath(asString(input, "source"));
    const appleOutputDir = asOptionalString(input, "appleOutputDir");
    const androidResDir = asOptionalString(input, "androidResDir");
    const background = asOptionalString(input, "background") ?? "#ffffff";
    const rawApplePlatforms = asRecord(input).applePlatforms;
    const applePlatforms = Array.isArray(rawApplePlatforms)
      ? rawApplePlatforms.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : ["ios", "macos"];
    const files: string[] = [];
    const outputs: Record<string, unknown> = {};

    if (appleOutputDir) {
      const result = await createAppleAppIconSetTool.run({ source, outputDir: ensureRelativePath(appleOutputDir), platforms: applePlatforms, background }, context);
      if (!result.ok) return result;
      files.push(...(result.files ?? []));
      outputs.apple = result.output;
    }
    if (androidResDir) {
      const result = await createAndroidLauncherIconSetTool.run({ source, resDir: ensureRelativePath(androidResDir), background }, context);
      if (!result.ok) return result;
      files.push(...(result.files ?? []));
      outputs.android = result.output;
    }
    if (!appleOutputDir && !androidResDir) {
      return { ok: false, summary: "No app icon output selected.", error: "Provide appleOutputDir, androidResDir, or both." };
    }

    return { ok: true, summary: `Generated ${files.length} app icon resource file${files.length === 1 ? "" : "s"}.`, output: outputs, files };
  },
};

function packageToDir(packageName: string): string {
  return packageName.split(".").map((part) => part.replace(/[^A-Za-z0-9_]/g, "")).filter(Boolean).join("/");
}

function kotlinIdentifier(input: string, fallback: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9_]/g, "").replace(/^[0-9]+/, "");
  return cleaned || fallback;
}

function addLineBeforeClosingPluginsBlock(gradle: string, line: string): string {
  if (gradle.includes(line)) return gradle;
  return gradle.replace(/plugins\s*\{([\s\S]*?)\n\}/, (match, body) => `plugins {${body}\n    ${line}\n}`);
}

function addDependencyLine(gradle: string, line: string): string {
  if (gradle.includes(line)) return gradle;
  return gradle.replace(/dependencies\s*\{/, `dependencies {\n    ${line}`);
}

async function maybePatchAndroidGradle(context: ToolContext, rootGradlePath: string, moduleGradlePath: string): Promise<string[]> {
  const files: string[] = [];
  const rootAbs = resolveInsideWorkspace(context.workspace, rootGradlePath);
  if (existsSync(rootAbs)) {
    const rootGradle = await readFile(rootAbs, "utf8");
    const nextRootGradle = addLineBeforeClosingPluginsBlock(rootGradle, "id(\"com.google.devtools.ksp\") version \"1.9.24-1.0.20\" apply false");
    if (nextRootGradle !== rootGradle) {
      await writeFile(rootAbs, nextRootGradle, "utf8");
      files.push(rootGradlePath);
    }
  }

  const moduleAbs = resolveInsideWorkspace(context.workspace, moduleGradlePath);
  if (existsSync(moduleAbs)) {
    let moduleGradle = await readFile(moduleAbs, "utf8");
    const before = moduleGradle;
    moduleGradle = addLineBeforeClosingPluginsBlock(moduleGradle, "id(\"com.google.devtools.ksp\")");
    for (const dependency of [
      "implementation(\"androidx.navigation:navigation-compose:2.8.3\")",
      "implementation(\"androidx.compose.material:material-icons-extended\")",
      "implementation(\"androidx.room:room-runtime:2.6.1\")",
      "implementation(\"androidx.room:room-ktx:2.6.1\")",
      "ksp(\"androidx.room:room-compiler:2.6.1\")",
    ]) {
      moduleGradle = addDependencyLine(moduleGradle, dependency);
    }
    if (moduleGradle !== before) {
      await writeFile(moduleAbs, moduleGradle, "utf8");
      files.push(moduleGradlePath);
    }
  }
  return files;
}

export const createAndroidFoundationTool: TanyaTool = {
  name: "create_android_foundation",
  description: "Create a generic Kotlin/Compose Android foundation with Material 3 theme, Navigation Compose, Room, and base UI states.",
  definition: {
    type: "function",
    function: {
      name: "create_android_foundation",
      description: "Create deterministic Android foundation files for a Kotlin/Compose app. Optionally updates Gradle with Navigation Compose and Room/KSP dependencies.",
      parameters: {
        type: "object",
        properties: {
          packageName: { type: "string", description: "Android package name, for example com.example.app." },
          appName: { type: "string", description: "Human app name. Default App." },
          sourceRoot: { type: "string", description: "Kotlin source root. Default app/src/main/java." },
          rootGradlePath: { type: "string", description: "Root build.gradle.kts path. Default build.gradle.kts." },
          moduleGradlePath: { type: "string", description: "App module build.gradle.kts path. Default app/build.gradle.kts." },
          brandPrimaryHex: { type: "string", description: "Primary brand color, for example #A52A2A. Default #A52A2A." },
          brandSecondaryHex: { type: "string", description: "Secondary brand color. Default #2D3748." },
          updateGradle: { type: "boolean", description: "Update Gradle plugins/dependencies. Default true." },
          preserveExisting: { type: "boolean", description: "Preserve existing foundation source files instead of overwriting them. Default true." },
          overwriteExisting: { type: "boolean", description: "Overwrite existing foundation source files. Default false." },
        },
        required: ["packageName"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const packageName = asString(input, "packageName").trim();
    const appName = asOptionalString(input, "appName") ?? "App";
    const sourceRoot = ensureRelativePath(asOptionalString(input, "sourceRoot") ?? "app/src/main/java").replace(/\/+$/, "");
    const rootGradlePath = ensureRelativePath(asOptionalString(input, "rootGradlePath") ?? "build.gradle.kts");
    const moduleGradlePath = ensureRelativePath(asOptionalString(input, "moduleGradlePath") ?? "app/build.gradle.kts");
    const brandPrimaryHex = (asOptionalString(input, "brandPrimaryHex") ?? "#A52A2A").replace(/^#?/, "0xFF");
    const brandSecondaryHex = (asOptionalString(input, "brandSecondaryHex") ?? "#2D3748").replace(/^#?/, "0xFF");
    const updateGradle = asOptionalBoolean(input, "updateGradle", true);
    const overwriteExisting = asOptionalBoolean(input, "overwriteExisting", false);
    const preserveExisting = overwriteExisting ? false : asOptionalBoolean(input, "preserveExisting", true);
    const packageDir = packageToDir(packageName);
    if (!packageDir) return { ok: false, summary: "Invalid package name.", error: "packageName must contain at least one valid package segment." };

    const classPrefix = kotlinIdentifier(appName, "App");
    const baseDir = `${sourceRoot}/${packageDir}`;
    const files: string[] = [];
    const outputs: Array<[string, string]> = [
      [`${baseDir}/ui/theme/AppTheme.kt`, buildAndroidThemeFile(packageName, brandPrimaryHex, brandSecondaryHex)],
      [`${baseDir}/navigation/AppNavigation.kt`, buildAndroidNavigationFile(packageName)],
      [`${baseDir}/data/AppDatabase.kt`, buildAndroidDatabaseFile(packageName, classPrefix)],
      [`${baseDir}/ui/components/FoundationStates.kt`, buildAndroidFoundationStatesFile(packageName)],
    ];

    for (const [path, content] of outputs) {
      const target = resolveInsideWorkspace(context.workspace, path);
      if (preserveExisting && existsSync(target)) continue;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      files.push(path);
    }
    if (updateGradle) files.push(...await maybePatchAndroidGradle(context, rootGradlePath, moduleGradlePath));

    return {
      ok: true,
      summary: preserveExisting
        ? `Created missing Android foundation files for ${packageName}; preserved existing source files.`
        : `Created Android foundation for ${packageName}.`,
      output: { packageName, appName, sourceRoot, updateGradle, preserveExisting },
      files,
    };
  },
};

function buildAndroidThemeFile(packageName: string, brandPrimaryHex: string, brandSecondaryHex: string): string {
  return [
    `package ${packageName}.ui.theme`,
    "",
    "import android.os.Build",
    "import androidx.compose.foundation.isSystemInDarkTheme",
    "import androidx.compose.material3.MaterialTheme",
    "import androidx.compose.material3.Typography",
    "import androidx.compose.material3.darkColorScheme",
    "import androidx.compose.material3.dynamicDarkColorScheme",
    "import androidx.compose.material3.dynamicLightColorScheme",
    "import androidx.compose.material3.lightColorScheme",
    "import androidx.compose.runtime.Composable",
    "import androidx.compose.ui.graphics.Color",
    "import androidx.compose.ui.platform.LocalContext",
    "",
    "object BrandColors {",
    `    val Primary = Color(${brandPrimaryHex})`,
    `    val Secondary = Color(${brandSecondaryHex})`,
    "    val Background = Color(0xFF0B0B0F)",
    "    val Surface = Color(0xFF16161D)",
    "    val OnPrimary = Color.White",
    "    val OnBackground = Color(0xFFF8FAFC)",
    "    val OnSurface = Color(0xFFE5E7EB)",
    "}",
    "",
    "private val DarkColors = darkColorScheme(",
    "    primary = BrandColors.Primary,",
    "    secondary = BrandColors.Secondary,",
    "    background = BrandColors.Background,",
    "    surface = BrandColors.Surface,",
    "    onPrimary = BrandColors.OnPrimary,",
    "    onBackground = BrandColors.OnBackground,",
    "    onSurface = BrandColors.OnSurface,",
    ")",
    "",
    "private val LightColors = lightColorScheme(",
    "    primary = BrandColors.Primary,",
    "    secondary = BrandColors.Secondary,",
    ")",
    "",
    "@Composable",
    "fun AppTheme(",
    "    darkTheme: Boolean = isSystemInDarkTheme(),",
    "    dynamicColor: Boolean = false,",
    "    content: @Composable () -> Unit,",
    ") {",
    "    val colorScheme = when {",
    "        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {",
    "            val context = LocalContext.current",
    "            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)",
    "        }",
    "        darkTheme -> DarkColors",
    "        else -> LightColors",
    "    }",
    "",
    "    MaterialTheme(",
    "        colorScheme = colorScheme,",
    "        typography = Typography(),",
    "        content = content,",
    "    )",
    "}",
    "",
  ].join("\n");
}

function buildAndroidNavigationFile(packageName: string): string {
  return [
    `package ${packageName}.navigation`,
    "",
    "import androidx.compose.foundation.layout.padding",
    "import androidx.compose.material.icons.Icons",
    "import androidx.compose.material.icons.filled.Home",
    "import androidx.compose.material.icons.filled.List",
    "import androidx.compose.material.icons.filled.Settings",
    "import androidx.compose.material3.Icon",
    "import androidx.compose.material3.NavigationBar",
    "import androidx.compose.material3.NavigationBarItem",
    "import androidx.compose.material3.Scaffold",
    "import androidx.compose.material3.Text",
    "import androidx.compose.runtime.Composable",
    "import androidx.compose.runtime.getValue",
    "import androidx.compose.ui.Modifier",
    "import androidx.compose.ui.graphics.vector.ImageVector",
    "import androidx.navigation.NavHostController",
    "import androidx.navigation.compose.NavHost",
    "import androidx.navigation.compose.composable",
    "import androidx.navigation.compose.currentBackStackEntryAsState",
    "import androidx.navigation.compose.rememberNavController",
    `import ${packageName}.ui.components.EmptyState`,
    "",
    "sealed class AppRoute(val path: String, val label: String, val icon: ImageVector) {",
    "    data object Home : AppRoute(\"home\", \"Home\", Icons.Filled.Home)",
    "    data object Features : AppRoute(\"features\", \"Features\", Icons.Filled.List)",
    "    data object Settings : AppRoute(\"settings\", \"Settings\", Icons.Filled.Settings)",
    "}",
    "",
    "private val bottomNavItems = listOf(AppRoute.Home, AppRoute.Features, AppRoute.Settings)",
    "",
    "@Composable",
    "fun AppScaffold() {",
    "    val navController = rememberNavController()",
    "    val backStackEntry by navController.currentBackStackEntryAsState()",
    "    val currentPath = backStackEntry?.destination?.route",
    "",
    "    Scaffold(",
    "        bottomBar = {",
    "            NavigationBar {",
    "                bottomNavItems.forEach { route ->",
    "                    NavigationBarItem(",
    "                        selected = currentPath == route.path,",
    "                        onClick = {",
    "                            navController.navigate(route.path) {",
    "                                popUpTo(navController.graph.startDestinationId) { saveState = true }",
    "                                launchSingleTop = true",
    "                                restoreState = true",
    "                            }",
    "                        },",
    "                        icon = { Icon(route.icon, contentDescription = route.label) },",
    "                        label = { Text(route.label) },",
    "                    )",
    "                }",
    "            }",
    "        },",
    "    ) { padding ->",
    "        AppNavHost(navController = navController, modifier = Modifier.padding(padding))",
    "    }",
    "}",
    "",
    "@Composable",
    "fun AppNavHost(navController: NavHostController, modifier: Modifier = Modifier) {",
    "    NavHost(navController = navController, startDestination = AppRoute.Home.path, modifier = modifier) {",
    "        composable(AppRoute.Home.path) { EmptyState(title = \"Home\", message = \"Foundation ready\") }",
    "        composable(AppRoute.Features.path) { EmptyState(title = \"Features\", message = \"Add feature screens here\") }",
    "        composable(AppRoute.Settings.path) { EmptyState(title = \"Settings\", message = \"Configure preferences here\") }",
    "    }",
    "}",
    "",
  ].join("\n");
}

function buildAndroidDatabaseFile(packageName: string, classPrefix: string): string {
  return [
    `package ${packageName}.data`,
    "",
    "import android.content.Context",
    "import androidx.room.Dao",
    "import androidx.room.Database",
    "import androidx.room.Entity",
    "import androidx.room.Insert",
    "import androidx.room.OnConflictStrategy",
    "import androidx.room.PrimaryKey",
    "import androidx.room.Query",
    "import androidx.room.Room",
    "import androidx.room.RoomDatabase",
    "import kotlinx.coroutines.flow.Flow",
    "",
    "@Entity(tableName = \"local_items\")",
    "data class LocalItemEntity(",
    "    @PrimaryKey(autoGenerate = true) val id: Long = 0,",
    "    val title: String,",
    "    val createdAt: Long = System.currentTimeMillis(),",
    "    val updatedAt: Long = System.currentTimeMillis(),",
    "    val isDeleted: Boolean = false,",
    ")",
    "",
    "@Dao",
    "interface LocalItemDao {",
    "    @Query(\"SELECT * FROM local_items WHERE isDeleted = 0 ORDER BY createdAt DESC\")",
    "    fun observeAll(): Flow<List<LocalItemEntity>>",
    "",
    "    @Insert(onConflict = OnConflictStrategy.REPLACE)",
    "    suspend fun upsert(item: LocalItemEntity): Long",
    "",
    "    @Query(\"UPDATE local_items SET isDeleted = 1, updatedAt = :now WHERE id = :id\")",
    "    suspend fun softDelete(id: Long, now: Long = System.currentTimeMillis())",
    "}",
    "",
    "@Database(",
    "    entities = [LocalItemEntity::class],",
    "    version = 1,",
    "    exportSchema = true,",
    ")",
    "abstract class AppDatabase : RoomDatabase() {",
    "    abstract fun localItemDao(): LocalItemDao",
    "",
    "    companion object {",
    "        @Volatile",
    "        private var instance: AppDatabase? = null",
    "",
    "        fun getInstance(context: Context): AppDatabase =",
    "            instance ?: synchronized(this) {",
    "                instance ?: Room.databaseBuilder(",
    "                    context.applicationContext,",
    "                    AppDatabase::class.java,",
    `                    "${classPrefix.toLowerCase()}_database",`,
    "                )",
    "                    .fallbackToDestructiveMigration()",
    "                    .build()",
    "                    .also { instance = it }",
    "            }",
    "    }",
    "}",
    "",
  ].join("\n");
}

function buildAndroidFoundationStatesFile(packageName: string): string {
  return [
    `package ${packageName}.ui.components`,
    "",
    "import androidx.compose.foundation.layout.Arrangement",
    "import androidx.compose.foundation.layout.Box",
    "import androidx.compose.foundation.layout.Column",
    "import androidx.compose.foundation.layout.fillMaxSize",
    "import androidx.compose.foundation.layout.padding",
    "import androidx.compose.material3.Button",
    "import androidx.compose.material3.CircularProgressIndicator",
    "import androidx.compose.material3.MaterialTheme",
    "import androidx.compose.material3.Text",
    "import androidx.compose.runtime.Composable",
    "import androidx.compose.ui.Alignment",
    "import androidx.compose.ui.Modifier",
    "import androidx.compose.ui.unit.dp",
    "",
    "@Composable",
    "fun LoadingState(modifier: Modifier = Modifier) {",
    "    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {",
    "        CircularProgressIndicator()",
    "    }",
    "}",
    "",
    "@Composable",
    "fun EmptyState(",
    "    title: String,",
    "    message: String,",
    "    modifier: Modifier = Modifier,",
    ") {",
    "    Column(",
    "        modifier = modifier.fillMaxSize().padding(24.dp),",
    "        horizontalAlignment = Alignment.CenterHorizontally,",
    "        verticalArrangement = Arrangement.Center,",
    "    ) {",
    "        Text(text = title, style = MaterialTheme.typography.headlineSmall)",
    "        Text(text = message, style = MaterialTheme.typography.bodyMedium)",
    "    }",
    "}",
    "",
    "@Composable",
    "fun ErrorState(",
    "    message: String,",
    "    onRetry: () -> Unit,",
    "    modifier: Modifier = Modifier,",
    ") {",
    "    Column(",
    "        modifier = modifier.fillMaxSize().padding(24.dp),",
    "        horizontalAlignment = Alignment.CenterHorizontally,",
    "        verticalArrangement = Arrangement.Center,",
    "    ) {",
    "        Text(text = message, color = MaterialTheme.colorScheme.error)",
    "        Button(onClick = onRetry) { Text(\"Retry\") }",
    "    }",
    "}",
    "",
  ].join("\n");
}

export const commitPlatformChangesTool: TanyaTool = {
  name: "commit_platform_changes",
  description: "Stage selected files and create a git commit from the workspace or repository root.",
  definition: {
    type: "function",
    function: {
      name: "commit_platform_changes",
      description: "Stage explicit changed files and create a git commit. Use this instead of hand-written git add/commit shell commands when possible.",
      parameters: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" }, description: "Files to stage, relative to the workspace." },
          message: { type: "string", description: "Commit message." },
          amend: { type: "boolean", description: "If true, amend the current HEAD with these staged paths instead of creating a new commit." },
        },
        required: ["files", "message"],
        additionalProperties: false,
      },
    },
  },
  async run(input, context) {
    const message = asString(input, "message");
    const amend = asOptionalBoolean(input, "amend", false);
    const record = asRecord(input);
    const rawPaths = Array.isArray(record.files) ? record.files : record.paths;
    const paths = Array.isArray(rawPaths)
      ? rawPaths.filter((path): path is string => typeof path === "string" && path.trim().length > 0).map(ensureRelativePath)
      : [];
    if (paths.length === 0) return { ok: false, summary: "No paths provided for commit.", error: "Provide at least one path to stage." };
    for (const path of paths) if (isProtectedLocalConfigPath(path)) return localPropertiesWriteError();

    const rootResult = await runProcess("git", ["rev-parse", "--show-toplevel"], context, 20_000);
    if (!rootResult.ok || typeof rootResult.output !== "string") {
      return { ok: false, summary: "Could not resolve git root.", error: rootResult.error ?? String(rootResult.output ?? "") };
    }
    const repoRoot = rootResult.output.split(/\r?\n/)[0]?.trim();
    if (!repoRoot) return { ok: false, summary: "Could not resolve git root.", error: "git rev-parse returned empty output." };
    const realRepoRoot = await realpath(repoRoot);
    const realWorkspace = await realpath(context.workspace);
    const repoPaths = await Promise.all(paths.map(async (path) => {
      const cleanPath = normalizeRelativePathForGit(path);
      const workspaceCandidate = resolveInsideWorkspace(realWorkspace, cleanPath);
      const repoCandidate = resolveInsideWorkspace(realRepoRoot, cleanPath);
      if (existsSync(repoCandidate)) return relative(realRepoRoot, await realpath(repoCandidate)).replace(/\\/g, "/");
      if (existsSync(workspaceCandidate)) return relative(realRepoRoot, await realpath(workspaceCandidate)).replace(/\\/g, "/");
      const workspacePrefix = normalizeRelativePathForGit(relative(realRepoRoot, realWorkspace));
      if (workspacePrefix && workspacePrefix !== "." && (cleanPath === workspacePrefix || cleanPath.startsWith(`${workspacePrefix}/`))) return cleanPath;
      const workspaceRelative = normalizeRelativePathForGit(relative(realRepoRoot, workspaceCandidate));
      if (!workspaceRelative.startsWith("../") && workspaceRelative !== "..") return workspaceRelative;
      return cleanPath;
    }));
    if (repoPaths.some((path) => path === ".." || path.startsWith("../"))) {
      return { ok: false, summary: "Commit paths rejected.", error: "All commit paths must be inside the git repository root." };
    }
    const addResult = await withGitLockRetry("git add", () => runProcess("git", ["add", ...repoPaths], context, 60_000, realRepoRoot));
    if (!addResult.ok) return { ...addResult, summary: "git add failed.", files: paths };
    const commitArgs = amend ? ["commit", "--amend", "-m", message] : ["commit", "-m", message];
    const commitResult = await withGitLockRetry("git commit", () => runProcess("git", commitArgs, context, 60_000, realRepoRoot));
    if (!commitResult.ok) return { ...commitResult, summary: "git commit failed.", files: paths };
    const headResult = await runProcess("git", ["rev-parse", "--short", "HEAD"], context, 20_000, realRepoRoot);
    return {
      ok: true,
      summary: `${amend ? "Amended commit with" : "Committed"} ${paths.length} path${paths.length === 1 ? "" : "s"}.`,
      output: { repoRoot: realRepoRoot, head: typeof headResult.output === "string" ? headResult.output.trim().split(/\r?\n/)[0] : null, message, amend },
      files: paths,
    };
  },
};
