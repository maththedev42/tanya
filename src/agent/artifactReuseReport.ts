// Artifact-reuse report munging: parses/normalizes the `Artifact reused:`
// lines a coding report must carry, reconciles them against the manifest's
// artifactsRead/changedFiles, and derives the structured reuse entries.
// Extracted from report.ts (R2b); must stay import-free of report.ts.
import type { TanyaRunContext } from "../context/runContext";
import type { TanyaFinalManifest } from "./runner";
import { uniqueSorted } from "./git";

export function hasRequiredCodingReport(text: string): boolean {
  return /Verification:\s*.+->/i.test(text)
    && (/Modified:\s*/i.test(text) || /Verification-only:\s*existing setup satisfied/i.test(text) || /Blocked?:/i.test(text));
}

export type StructuredArtifactReuse = {
  artifact: string;
  targets: string[];
};

/** Map a materialized artifact path back to its declared source path. */
export function sourceArtifactPath(localPath: string, runContext?: TanyaRunContext): string {
  const match = runContext?.artifacts?.find((artifact) => artifact.path === localPath || artifact.sourcePath === localPath);
  if (match?.sourcePath) return match.sourcePath;
  if (localPath.startsWith(".tanya/artifacts/")) return localPath.replace(/^\.tanya\/artifacts\//, "artifacts/");
  return localPath;
}

export function explicitArtifactReuseNone(text: string): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => /^Artifact reused:\s*none\b/i.test(normalizeReportLabel(line)));
}

export function explicitArtifactReuseNoneWithRationale(text: string): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => {
      const normalized = normalizeReportLabel(line);
      return /^Artifact reused:\s*none\b/i.test(normalized) &&
        /\b(?:read for context|not directly|doesn'?t directly|already in place|not used|no matched artifacts? relevant)\b/i.test(normalized);
    });
}

function cleanArtifactTargetPath(value: string): string {
  return value
    .replace(/`/g, "")
    .replace(/\s+[—-]\s+.*$/, "")
    .replace(/\s+\(.*$/, "")
    .replace(/;.*$/, "")
    .trim();
}

function isArtifactTargetPath(value: string): boolean {
  return value === "verification-only" ||
    value === "reusable artifact" ||
    /(?:^|\/)[^/\s]+\.[A-Za-z0-9]+$/.test(value);
}

function normalizeReportLabel(line: string): string {
  return line
    .replace(/^[-*]\s*/, "")
    .replace(/^\*\*(Artifact reused|Artifact created|Modified|Verification|Manual check|Blocked):\*\*/i, "$1:")
    .replace(/^`(Artifact reused|Artifact created|Modified|Verification|Manual check|Blocked):`/i, "$1:")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s*→\s*/g, " -> ")
    .trim();
}

function canonicalArtifactReuseLine(line: string): string {
  const cleaned = normalizeReportLabel(line);
  const match = cleaned.match(/^(Artifact reused:\s*.+?)\s*->\s*(.+)$/i);
  if (!match) return cleaned;
  const prefix = match[1]?.trim() ?? "";
  const rawTarget = (match[2] ?? "").trim();
  if (/^(?:none|n\/a|not used|unused)\b/i.test(rawTarget)) return "Artifact reused: none";
  const targets = (match[2] ?? "")
    .split(",")
    .map(cleanArtifactTargetPath)
    .filter(isArtifactTargetPath);
  return targets.length > 0 ? `${prefix} -> ${targets.join(", ")}` : "Artifact reused: none";
}

export function explicitArtifactReuseLines(text: string): string[] {
  return uniqueSorted(text
    .split(/\r?\n/)
    .map(canonicalArtifactReuseLine)
    .filter((line) => /^Artifact reused:\s+/i.test(line))
    .filter((line) => !/^Artifact reused:\s*none\b/i.test(line)));
}

export function explicitArtifactReuseLinesForManifest(
  text: string,
  manifest: Pick<TanyaFinalManifest, "artifactsRead" | "changedFiles">,
  runContext?: TanyaRunContext,
): string[] {
  if (manifest.artifactsRead.length === 0) return explicitArtifactReuseLines(text);
  const artifactPaths = new Set(manifest.artifactsRead.flatMap((artifactPath) => [
    artifactPath,
    sourceArtifactPath(artifactPath, runContext),
  ]));
  const changedFiles = new Set(manifest.changedFiles);
  return explicitArtifactReuseLines(text).filter((line) => {
    const match = line.match(/^Artifact reused:\s*(.+?)\s*->\s*(.+)$/i);
    if (!match) return false;
    const artifact = match[1]?.trim();
    if (!artifact || !artifactPaths.has(artifact)) return false;
    const targets = (match[2] ?? "")
      .split(",")
      .map((target) => target.trim())
      .filter(Boolean);
    return targets.length > 0 && targets.every((target) => target === "verification-only" || changedFiles.has(target));
  });
}

export function artifactTargetFiles(artifactPath: string, changedFiles: string[]): string[] {
  if (/artifacts\/ios\/SplashScreenPattern\.swift$|\.tanya\/artifacts\/ios\/SplashScreenPattern\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)SplashScreenView\.swift$/.test(file));
  }
  if (/artifacts\/ios\/OnboardingFlowPattern\.swift$|\.tanya\/artifacts\/ios\/OnboardingFlowPattern\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:OnboardingView|OnboardingPageView)\.swift$|(?:^|\/)[^/]+App\.swift$/.test(file));
  }
  if (/artifacts\/ios\/ColorHex\.swift$|\.tanya\/artifacts\/ios\/ColorHex\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:ColorHex|Colors|ThemeSystem)\.swift$/.test(file));
  }
  if (/artifacts\/ios\/ThemeSystem\.swift$|\.tanya\/artifacts\/ios\/ThemeSystem\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:Theme\/)?(?:ThemeSystem|Colors|Typography|ViewModifiers)\.swift$/.test(file));
  }
  if (/artifacts\/ios\/NavigationSetup\.swift$|\.tanya\/artifacts\/ios\/NavigationSetup\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:Navigation\/)?(?:NavigationSetup|AppNavigation|NavigationView)\.swift$|(?:^|\/)ContentView\.swift$|(?:^|\/)[^/]+App\.swift$/.test(file));
  }
  if (/artifacts\/ios\/SwiftDataSetup\.swift$|\.tanya\/artifacts\/ios\/SwiftDataSetup\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:Models\/)?(?:SwiftDataSetup|Models|.*Model)\.swift$|(?:^|\/)[^/]+App\.swift$/.test(file));
  }
  if (/artifacts\/ios\/MultiPlatformAppleSetup\.swift$|\.tanya\/artifacts\/ios\/MultiPlatformAppleSetup\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:ContentView|[^/]+App|Platform|Root)\.swift$/.test(file));
  }
  if (/artifacts\/ios\/DebugLogger\.swift$|\.tanya\/artifacts\/ios\/DebugLogger\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:DebugLogger|Logger|Logging)\.swift$/.test(file));
  }
  if (/artifacts\/ios\/Localization\.swift$|\.tanya\/artifacts\/ios\/Localization\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:Localization|Localiz(?:able|ation)|Strings)\.swift$|(?:^|\/)[^/]+\.strings$/.test(file));
  }
  if (/artifacts\/ios\/OfflineCachePatterns\.swift$|\.tanya\/artifacts\/ios\/OfflineCachePatterns\.swift$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:Offline|Cache|Sync|Repository|Store)[^/]*\.swift$/.test(file));
  }
  if (/artifacts\/android\/SplashScreenPattern\.kt$|\.tanya\/artifacts\/android\/SplashScreenPattern\.kt$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:SplashScreen|MainActivity)\.kt$/.test(file));
  }
  if (/artifacts\/android\/OnboardingFlowPattern\.kt$|\.tanya\/artifacts\/android\/OnboardingFlowPattern\.kt$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:OnboardingScreen|OnboardingDataStore|MainActivity|AppNavigation)\.kt$|(?:^|\/)app\/build\.gradle\.kts$/.test(file));
  }
  if (/artifacts\/android\/ThemeSystem\.kt$|\.tanya\/artifacts\/android\/ThemeSystem\.kt$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)ui\/theme\/(?:AppTheme|Color|Theme|Type)\.kt$/.test(file));
  }
  if (/artifacts\/android\/NavigationSetup\.kt$|\.tanya\/artifacts\/android\/NavigationSetup\.kt$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)navigation\/[^/]+\.kt$|(?:^|\/)MainActivity\.kt$/.test(file));
  }
  if (/artifacts\/android\/RoomSetup\.kt$|\.tanya\/artifacts\/android\/RoomSetup\.kt$/.test(artifactPath)) {
    return changedFiles.filter((file) =>
      /(?:^|\/)(?:app\/schemas\/|build\.gradle\.kts$|app\/build\.gradle\.kts$)/.test(file) ||
      /(?:^|\/)data\/.*(?:Database|Entity|Dao|Room|Migration|Repository)\.kt$/.test(file)
    );
  }
  if (/artifacts\/android\/FeatureScreenPatterns\.kt$|\.tanya\/artifacts\/android\/FeatureScreenPatterns\.kt$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)ui\/components\/[^/]+\.kt$|(?:^|\/)ui\/screens\/[^/]+\.kt$/.test(file));
  }
  if (/artifacts\/android\/OfflineCachePatterns\.kt$|\.tanya\/artifacts\/android\/OfflineCachePatterns\.kt$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:data\/.*(?:Cache|Sync|Offline)|work\/|network\/).*\.kt$/.test(file));
  }
  if (artifactPath.endsWith("artifacts/ios/FastlaneSetup.md") || artifactPath.endsWith(".tanya/artifacts/ios/FastlaneSetup.md")) {
    return changedFiles.filter((file) => file === "fastlane/Fastfile" || file === "fastlane/Appfile" || /(?:^|\/)ExportOptions-[^/]+\.plist$/.test(file));
  }
  if (/artifacts\/android\/FastlaneSetup\.md$|\.tanya\/artifacts\/android\/FastlaneSetup\.md$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)fastlane\/Fastfile$|(?:^|\/)fastlane\/Appfile$/.test(file));
  }
  if (/artifacts\/android\/PlayRelease_ManualSteps\.md$|\.tanya\/artifacts\/android\/PlayRelease_ManualSteps\.md$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)fastlane\/Fastfile$|(?:^|\/)gradle\.properties$/.test(file));
  }
  if (/artifacts\/backend\/JwtAuthRoutes\.ts$|\.tanya\/artifacts\/backend\/JwtAuthRoutes\.ts$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)app\/api\/[^/]+(?:\/.*)?\/route\.ts$|(?:^|\/)(?:lib\/(?:auth|.*Auth|routeWrappers)\.ts|middleware\.ts)$/.test(file));
  }
  if (/artifacts\/backend\/OpenApiSwaggerRoutes\.ts$|\.tanya\/artifacts\/backend\/OpenApiSwaggerRoutes\.ts$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)(?:lib\/openapi\.ts|app\/api\/(?:docs|openapi\.json)\/route\.ts|API_FEATURES\.md|brand\/api_features\.md)$/.test(file));
  }
  if (/artifacts\/backend\/PrismaBase\.prisma$|\.tanya\/artifacts\/backend\/PrismaBase\.prisma$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)prisma\/schema\.prisma$/.test(file));
  }
  if (/artifacts\/backend\/EnvExample\.txt$|\.tanya\/artifacts\/backend\/EnvExample\.txt$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)\.env\.example$/.test(file));
  }
  if (/artifacts\/testing\/MobileCIWorkflows\.md$|\.tanya\/artifacts\/testing\/MobileCIWorkflows\.md$/.test(artifactPath)) {
    return changedFiles.filter((file) => /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(file));
  }
  return [];
}

export function stripConflictingArtifactReuseLines(text: string, manifest: TanyaFinalManifest, force = false): string {
  if (!force && manifest.artifactsRead.length === 0) return text;
  const zeroChangeVerificationOnly = manifest.changedFiles.length === 0;
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (/^[-*]?\s*(?:\*\*)?`?Artifact reused:/i.test(trimmed)) return false;
      if (zeroChangeVerificationOnly && /\bArtifact reused:\s*/i.test(trimmed)) return false;
      return true;
    })
    .join("\n");
}

export function normalizeArtifactReuseLines(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => {
      const normalized = normalizeReportLabel(line);
      if (/^Artifact reused:\s*/i.test(normalized)) return canonicalArtifactReuseLine(normalized);
      if (/^Manual check:\s*/i.test(normalized) && !/\s->\s/.test(normalized)) return `${normalized} -> required after CLI`;
      return /^(Artifact created|Modified|Verification|Manual check|Blocked):\s*/i.test(normalized) ? normalized : line;
    });
  const hasSpecificReuse = lines.some((line) => /^Artifact reused:\s+/i.test(line) && !/^Artifact reused:\s*none\b/i.test(line));
  return lines
    .filter((line) => !(hasSpecificReuse && /^Artifact reused:\s*none\b/i.test(line)))
    .join("\n");
}

export function explicitManualCheckLines(text: string): string[] {
  const lines: string[] = [];
  let inManualSection = false;
  for (const line of text.split(/\r?\n/)) {
    const normalized = normalizeReportLabel(line);
    if (/^Manual check:\s*/i.test(normalized)) {
      lines.push(/\s->\s/.test(normalized) ? normalized : `${normalized} -> required after CLI`);
      continue;
    }
    if (
      /^#{1,6}\s*(?:Manual (?:checks?|testing)|What to test manually)\b/i.test(line.trim()) ||
      /^(?:Manual (?:checks?|testing)|What to test manually)\b/i.test(normalized)
    ) {
      inManualSection = true;
      continue;
    }
    if (inManualSection && /^#{1,6}\s+\S/.test(line.trim())) {
      inManualSection = false;
      continue;
    }
    if (!inManualSection) continue;
    const item = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/)?.[1];
    if (!item) continue;
    const cleaned = item
      .replace(/\*\*/g, "")
      .replace(/`/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned) lines.push(`Manual check: ${cleaned}${/\s->\s/.test(cleaned) ? "" : " -> required after CLI"}`);
  }
  return uniqueSorted(lines);
}

export function hasCompleteCodingReport(text: string): boolean {
  return hasRequiredCodingReport(text)
    && /Artifact reused:\s*/i.test(text)
    && /Artifact created:\s*/i.test(text)
    && (/Modified:\s*/i.test(text) || /Verification-only:\s*existing setup satisfied/i.test(text))
    && /Blocked:\s*/i.test(text);
}

export function buildArtifactReportLines(
  manifest: Pick<TanyaFinalManifest, "artifactsRead" | "changedFiles">,
  runContext?: TanyaRunContext,
  finalText = "",
): string[] {
  const availableCallerArtifacts = runContext?.artifacts
    ?.filter((artifact) => artifact.status !== "missing")
    .map((artifact) => artifact.path) ?? [];
  const explicitReuseLines = explicitArtifactReuseLinesForManifest(finalText, manifest, runContext);
  const shouldRespectExplicitNone = explicitReuseLines.length === 0 && explicitArtifactReuseNone(finalText);
  if (manifest.changedFiles.length === 0) return ["Artifact reused: none"];
  const artifactReportPaths = shouldRespectExplicitNone
    ? []
    : manifest.artifactsRead.length > 0
      ? manifest.artifactsRead
      : availableCallerArtifacts;
  if (artifactReportPaths.length > 0) {
    const mapped = artifactReportPaths.flatMap((artifactPath) => {
      const targetFiles = artifactTargetFiles(artifactPath, manifest.changedFiles);
      if (targetFiles.length > 0) return [`Artifact reused: ${sourceArtifactPath(artifactPath, runContext)} -> ${targetFiles.join(", ")}`];
      return [];
    });
    if (mapped.length > 0) return mapped;
  }
  if (explicitReuseLines.length > 0) {
    return uniqueSorted(explicitReuseLines);
  }
  return ["Artifact reused: none"];
}

export function structuredArtifactReuse(manifest: Pick<TanyaFinalManifest, "artifactsRead" | "changedFiles">, runContext?: TanyaRunContext, finalText = ""): StructuredArtifactReuse[] {
  const lines = buildArtifactReportLines(manifest, runContext, finalText);
  return lines
    .map((line): StructuredArtifactReuse | null => {
      const match = line.match(/^Artifact reused:\s*(.+?)\s*->\s*(.+)$/i);
      if (!match) return null;
      const artifact = match[1]?.trim();
      const targets = (match[2] ?? "")
        .split(",")
        .map((target) => target.trim())
        .filter(Boolean);
      if (!artifact || /^none$/i.test(artifact)) return null;
      return { artifact, targets };
    })
    .filter((entry): entry is StructuredArtifactReuse => entry !== null);
}

