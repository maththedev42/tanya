import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../src/agent/runner";
import { WRAP_UP_TURNS } from "../src/agent/progressBudget";
import { readRepairRunMemory } from "../src/memory/repairRuns";
import type { ChatProvider, ChatRequest } from "../src/providers/types";
import type { TanyaEvent } from "../src/events/types";

function makeProvider(responses: string[]): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    id: "test",
    model: "test-model",
    requests,
    async *streamChat(input: ChatRequest) {
      requests.push({ ...input, messages: [...input.messages] });
      yield { content: responses[Math.min(requests.length - 1, responses.length - 1)] ?? "" };
    },
  };
}

describe("runAgent final report — artifact reuse lines", () => {
  it("includes artifact provenance in fallback coding reports", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        yield {
          content: "Checking artifact.",
          toolCalls: [
            {
              id: "read-artifact",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: ".tanya/artifacts/ios/FastlaneSetup.md" }),
              },
            },
          ],
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-artifact-report-"));
    mkdirSync(join(cwd, ".tanya", "artifacts", "ios"), { recursive: true });
    writeFileSync(join(cwd, ".tanya", "artifacts", "ios", "FastlaneSetup.md"), "fastlane");

    const events: TanyaEvent[] = [];
    const { message: result } = await runAgent({
      provider,
      prompt: "Verify setup.",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 1,
      runContext: {
        task: { kind: "coding" },
        artifacts: [
          {
            path: ".tanya/artifacts/example.md",
            sourcePath: "artifacts/example.md",
            status: "available",
          },
        ],
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Artifact reused: none");
    expect(result).not.toContain("Artifact reused: artifacts/ios/FastlaneSetup.md");
    expect(result).toContain("Verification-only: existing setup satisfied");
    const finalEvent = events.find((event) => event.type === "final");
    expect(finalEvent?.manifest?.artifactsRead).toEqual(["artifacts/ios/FastlaneSetup.md"]);
  });

  it("strips prose artifact reuse claims from zero-change verification-only reports", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Checking existing Android splash.",
            toolCalls: [
              {
                id: "read-artifact",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: ".tanya/artifacts/android/SplashScreenPattern.kt" }),
                },
              },
              {
                id: "verify",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ command: "./gradlew assembleDebug --no-daemon" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "**Verification-only: existing setup satisfied**",
            "- `Artifact reused: artifacts/android/SplashScreenPattern.kt -> app/src/main/java/com/example/SplashScreen.kt` (already adapted)",
            "- `Artifact created: none`",
            "- `Modified: none`",
            "- `Verification: ./gradlew assembleDebug --no-daemon -> BUILD SUCCESSFUL`",
            "- `Blocked: none`",
          ].join("\n"),
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-zero-change-strip-artifact-prose-"));
    mkdirSync(join(cwd, ".tanya", "artifacts", "android"), { recursive: true });
    writeFileSync(join(cwd, ".tanya", "artifacts", "android", "SplashScreenPattern.kt"), "splash");

    const { message: result } = await runAgent({
      provider,
      prompt: "Verify Android splash.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding", title: "Splash Screen - Android" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: none");
    expect(result).not.toContain("Artifact reused: artifacts/android/SplashScreenPattern.kt -> app/src/main/java/com/example/SplashScreen.kt");
    expect(result).toContain("Verification-only: existing setup satisfied");
  });

  it("does not claim caller-provided artifacts when the model changes files without reading them", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        yield {
          content: "Creating file.",
          toolCalls: [
            {
              id: "write-file",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "App/Setup.swift", content: "import SwiftUI\n" }),
              },
            },
          ],
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-provided-artifact-report-"));

    const { message: result } = await runAgent({
      provider,
      prompt: "Do setup.",
      cwd,
      sink: async () => {},
      maxTurns: 1,
      runContext: {
        task: { kind: "coding" },
        artifacts: [
          {
            path: ".tanya/artifacts/example.md",
            sourcePath: "artifacts/example.md",
            status: "available",
          },
        ],
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: none");
    expect(result).toContain("core-artifact-provenance-missing");
    expect(result).toContain("Modified: App/Setup.swift");
  });

  it("uses manifest artifact targets when model prose under-reports reused files", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Reading setup artifact.",
            toolCalls: [
              {
                id: "read-artifact",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: ".tanya/artifacts/ios/FastlaneSetup.md" }),
                },
              },
              {
                id: "write-fastfile",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "fastlane/Fastfile", content: "lane :build do\nend\n" }),
                },
              },
              {
                id: "write-appfile",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "fastlane/Appfile", content: "app_identifier(\"x\")\n" }),
                },
              },
              {
                id: "write-swiftlint",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: ".swiftlint.yml", content: "disabled_rules: []\n" }),
                },
              },
              {
                id: "verify-fastfile",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "ruby -c fastlane/Fastfile" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/ios/FastlaneSetup.md -> fastlane/Fastfile",
            "Artifact created: none",
            "Modified: fastlane/Fastfile",
            "Modified: fastlane/Appfile",
            "Verification: ruby -c fastlane/Fastfile -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-artifact-targets-"));
    mkdirSync(join(cwd, ".tanya", "artifacts", "ios"), { recursive: true });
    writeFileSync(join(cwd, ".tanya", "artifacts", "ios", "FastlaneSetup.md"), "fastlane");

    const { message: result } = await runAgent({
      provider,
      prompt: "Set up iOS.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding", title: "Setup Environment - iOS" },
        artifacts: [{ path: ".tanya/artifacts/ios/FastlaneSetup.md", sourcePath: "artifacts/ios/FastlaneSetup.md", status: "available" }],
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/ios/FastlaneSetup.md -> fastlane/Appfile, fastlane/Fastfile");
    expect(result).not.toContain("Artifact reused: artifacts/ios/FastlaneSetup.md -> .swiftlint.yml");
  });

  it("does not synthesize artifact reuse when the final report explicitly says none", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Checking artifact.",
            toolCalls: [
              {
                id: "read-artifact",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: ".tanya/artifacts/testing/OpenApiDtoGeneration.md" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Creating setup file.",
            toolCalls: [
              {
                id: "write-file",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "App/Setup.swift", content: "import SwiftUI\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Summary: setup complete.",
            "Artifact reused: none — matched artifacts were read for context but not directly copied.",
            "Artifact created: none",
            "Modified: App/Setup.swift",
            "Verification: swift build -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-artifact-none-report-"));
    mkdirSync(join(cwd, ".tanya", "artifacts", "testing"), { recursive: true });
    writeFileSync(join(cwd, ".tanya", "artifacts", "testing", "OpenApiDtoGeneration.md"), "openapi");

    const { message: result } = await runAgent({
      provider,
      prompt: "Do setup.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        artifacts: [
          {
            path: ".tanya/artifacts/testing/OpenApiDtoGeneration.md",
            sourcePath: "artifacts/testing/OpenApiDtoGeneration.md",
            status: "available",
          },
        ],
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: none");
    expect(result).not.toContain("Artifact reused: artifacts/testing/OpenApiDtoGeneration.md");
  });

  it("does not map read-only iOS artifacts to unrelated changed files", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Reading multiple artifacts and changing theme.",
            toolCalls: [
              {
                id: "read-theme",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: ".tanya/artifacts/ios/ThemeSystem.swift" }),
                },
              },
              {
                id: "read-offline",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: ".tanya/artifacts/ios/OfflineCachePatterns.swift" }),
                },
              },
              {
                id: "write-colors",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/Theme/Colors.swift", content: "import SwiftUI\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/ios/ThemeSystem.swift -> CosaNostra/Theme/Colors.swift",
            "Artifact created: none",
            "Modified: CosaNostra/Theme/Colors.swift",
            "Verification: swift build -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-artifact-precise-ios-"));
    mkdirSync(join(cwd, ".tanya/artifacts/ios"), { recursive: true });
    writeFileSync(join(cwd, ".tanya/artifacts/ios/ThemeSystem.swift"), "theme");
    writeFileSync(join(cwd, ".tanya/artifacts/ios/OfflineCachePatterns.swift"), "offline");

    const { message: result } = await runAgent({
      provider,
      prompt: "Build iOS theme.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/ios/ThemeSystem.swift -> CosaNostra/Theme/Colors.swift");
    expect(result).not.toContain("OfflineCachePatterns.swift -> CosaNostra/Theme/Colors.swift");
  });

  it("does not append contradictory artifact lines after a duplicate-finalize path", async () => {
    let shellRuns = 0;
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: [
              "Artifact reused: none",
              "Artifact created: none",
              "Modified: android/app/build.gradle.kts",
              "Verification: ./gradlew ktlintCheck --no-daemon -> passed",
              "Blocked: none",
            ].join("\n"),
            toolCalls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "true # ./gradlew ktlintCheck --no-daemon" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: "Rechecking the same verification.",
          toolCalls: [
            {
              id: `call-${provider.requests.length}`,
              type: "function",
              function: {
                name: "run_shell",
                arguments: JSON.stringify({ script: "true # ./gradlew ktlintCheck --no-daemon" }),
              },
            },
          ],
        };
        shellRuns += 1;
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-duplicate-artifact-none-"));
    const { message: result } = await runAgent({
      provider,
      prompt: "Verify Android setup.",
      cwd,
      sink: async () => {},
      maxTurns: 8,
      runContext: {
        task: { kind: "coding" },
        artifacts: [
          {
            path: ".tanya/artifacts/android/FastlaneSetup.md",
            sourcePath: "artifacts/android/FastlaneSetup.md",
            status: "available",
          },
        ],
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(shellRuns).toBeGreaterThanOrEqual(1);
    expect(result).toContain("Artifact reused: none");
    expect(result).not.toContain("Artifact reused: artifacts/android/FastlaneSetup.md");
    expect((result.match(/Artifact reused:/g) ?? []).length).toBe(1);
  });

  it("does not contradict explicit artifact reuse none in the deterministic report", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating onboarding.",
            toolCalls: [
              {
                id: "read-nav",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: ".tanya/artifacts/android/NavigationSetup.kt" }),
                },
              },
              {
                id: "read-room",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: ".tanya/artifacts/android/RoomSetup.kt" }),
                },
              },
              {
                id: "write-main",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "app/src/main/java/com/example/MainActivity.kt", content: "package test\n" }),
                },
              },
              {
                id: "write-store",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "app/src/main/java/com/example/data/OnboardingPreferences.kt", content: "package test\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none — matched artifacts were read for context but not directly copied.",
            "Artifact created: none",
            "Modified: app/src/main/java/com/example/MainActivity.kt",
            "Modified: app/src/main/java/com/example/data/OnboardingPreferences.kt",
            "Verification: ./gradlew assembleDebug --no-daemon -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-artifact-none-deterministic-"));
    mkdirSync(join(cwd, ".tanya/artifacts/android"), { recursive: true });
    writeFileSync(join(cwd, ".tanya/artifacts/android/NavigationSetup.kt"), "package artifact\n");
    writeFileSync(join(cwd, ".tanya/artifacts/android/RoomSetup.kt"), "package artifact\n");

    const { message: result } = await runAgent({
      provider,
      prompt: "Create Android onboarding.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        artifacts: [
          {
            path: ".tanya/artifacts/android/NavigationSetup.kt",
            sourcePath: "artifacts/android/NavigationSetup.kt",
            status: "available",
          },
          {
            path: ".tanya/artifacts/android/RoomSetup.kt",
            sourcePath: "artifacts/android/RoomSetup.kt",
            status: "available",
          },
        ],
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("## Tanya deterministic report");
    expect(result).toContain("Artifact reused: none");
    expect(result).not.toContain("Artifact reused: artifacts/android/NavigationSetup.kt");
    expect(result).not.toContain("Artifact reused: artifacts/android/RoomSetup.kt");
    expect((result.match(/Artifact reused:/g) ?? []).length).toBe(1);
  });

  it("syncs reusable artifact output to the caller artifact root", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        yield {
          content: "Creating reusable artifact.",
          toolCalls: [
            {
              id: "write-artifact",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: ".tanya/artifact-output/backend/NewPattern.ts",
                  content: "export const pattern = true;\n",
                }),
              },
            },
          ],
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-artifact-output-"));
    const artifactRoot = mkdtempSync(join(tmpdir(), "tanya-output-artifacts-"));

    const { message: result } = await runAgent({
      provider,
      prompt: "Create a reusable backend artifact.",
      cwd,
      sink: async () => {},
      maxTurns: 1,
      runContext: {
        task: { kind: "coding" },
        expected_report: { artifact_created: true },
        metadata: { artifactOutputRoot: artifactRoot },
      },
    });

    expect(existsSync(join(artifactRoot, "backend", "NewPattern.ts"))).toBe(true);
    expect(readFileSync(join(artifactRoot, "backend", "NewPattern.ts"), "utf8")).toContain("pattern");
    expect(result).toContain("Artifact created: artifacts/backend/NewPattern.ts -> reusable artifact");
  });

  it("canonicalizes prose-heavy artifact reuse lines before adding the deterministic report", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating splash.",
            toolCalls: [
              {
                id: "write-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/SplashScreenView.swift", content: "import SwiftUI\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift` — adapted the generic splash pattern.",
            "Artifact created: none",
            "Modified: CosaNostra/SplashScreenView.swift",
            "Verification: xcodebuild build -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Create iOS splash.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-artifact-line-canonical-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift");
    expect(result).not.toContain("adapted the generic splash pattern");
  });

  it("strips parenthetical prose from artifact reuse targets", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating splash.",
            toolCalls: [
              {
                id: "write-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/SplashScreenView.swift", content: "import SwiftUI\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift (adapted from the generic pattern)",
            "Artifact created: none",
            "Modified: CosaNostra/SplashScreenView.swift",
            "Verification: xcodebuild build -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Create iOS splash.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-artifact-line-parenthetical-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift");
    expect(result).not.toContain("adapted from the generic pattern");
  });

  it("removes contradictory artifact reused none lines when specific reuse exists", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating splash.",
            toolCalls: [
              {
                id: "write-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "app/src/main/java/SplashScreen.kt", content: "package test\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/android/SplashScreenPattern.kt -> app/src/main/java/SplashScreen.kt",
            "Artifact reused: none (no other artifacts matched)",
            "Artifact created: none",
            "Modified: app/src/main/java/SplashScreen.kt",
            "Verification: ./gradlew ktlintCheck --no-daemon -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Create Android splash.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-artifact-contradictory-none-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/android/SplashScreenPattern.kt -> app/src/main/java/SplashScreen.kt");
    expect(result).not.toContain("Artifact reused: none");
  });

  it("does not infer Android splash XML resources as direct targets of the Kotlin splash artifact", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating Android splash from the reusable Kotlin pattern.",
            toolCalls: [
              {
                id: "read-artifact",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: ".tanya/artifacts/android/SplashScreenPattern.kt" }),
                },
              },
              {
                id: "write-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "app/src/main/java/SplashScreen.kt", content: "package test\n" }),
                },
              },
              {
                id: "write-theme",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "app/src/main/res/values/splash_theme.xml", content: "<resources />\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Modified: app/src/main/java/SplashScreen.kt",
            "Modified: app/src/main/res/values/splash_theme.xml",
            "Verification: ./gradlew assembleDebug --no-daemon -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-android-splash-artifact-targets-"));
    mkdirSync(join(cwd, ".tanya/artifacts/android"), { recursive: true });
    writeFileSync(join(cwd, ".tanya/artifacts/android/SplashScreenPattern.kt"), "fun SplashPattern() {}\n");

    const { message: result } = await runAgent({
      provider,
      prompt: "Create Android splash.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        artifacts: [{ sourcePath: "artifacts/android/SplashScreenPattern.kt", path: ".tanya/artifacts/android/SplashScreenPattern.kt" }],
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/android/SplashScreenPattern.kt -> app/src/main/java/SplashScreen.kt");
    expect(result).not.toContain("Artifact reused: artifacts/android/SplashScreenPattern.kt -> app/src/main/java/SplashScreen.kt, app/src/main/res/values/splash_theme.xml");
    expect(result).not.toContain("Artifact reused: artifacts/android/SplashScreenPattern.kt -> app/src/main/res/values/splash_theme.xml");
  });

  it("drops artifact reuse lines whose target is explicitly none", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        this.requests.push({ ...input, messages: [...input.messages] });
        if (this.requests.length === 1) {
          yield {
            content: "Creating Android foundation.",
            toolCalls: [
              {
                id: "write-theme",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "app/src/main/java/com/example/ui/theme/Theme.kt", content: "package test\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/android/ThemeSystem.kt -> app/src/main/java/com/example/ui/theme/Theme.kt",
            "Artifact reused: artifacts/android/OfflineCachePatterns.kt -> none (not used in this foundation step)",
            "Artifact created: none",
            "Modified: app/src/main/java/com/example/ui/theme/Theme.kt",
            "Verification: ./gradlew assembleDebug -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Build Android foundation.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-artifact-target-none-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/android/ThemeSystem.kt -> app/src/main/java/com/example/ui/theme/Theme.kt");
    expect(result).not.toContain("OfflineCachePatterns.kt -> none");
  });

  it("normalizes fully bold artifact reuse lines with explanatory text", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating iOS splash files.",
            toolCalls: [
              {
                id: "write-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/SplashScreenView.swift", content: "import SwiftUI\n" }),
                },
              },
              {
                id: "write-asset",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json", content: "{}\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "- **Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift** — adapted the generic splash structure.",
            "- **Artifact created:** none",
            "Modified: CosaNostra/SplashScreenView.swift",
            "Modified: CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
            "Verification: xcodebuild build -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Create iOS splash.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-fully-bold-artifact-line-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift");
    expect(result).not.toContain("CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json, CosaNostra/SplashScreenView.swift");
    expect(result).not.toContain("adapted the generic splash structure");
  });

  it("maps fallback artifact reuse to same-extension changed files when possible", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Reading artifact and writing files.",
            toolCalls: [
              {
                id: "read-artifact",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: ".tanya/artifacts/ios/SplashScreenPattern.swift" }),
                },
              },
              {
                id: "write-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/SplashScreenView.swift", content: "import SwiftUI\n" }),
                },
              },
              {
                id: "write-asset",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json", content: "{}\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact created: none",
            "Modified: CosaNostra/SplashScreenView.swift",
            "Modified: CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
            "Verification: xcodebuild build -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-artifact-same-extension-"));
    mkdirSync(join(cwd, ".tanya/artifacts/ios"), { recursive: true });
    writeFileSync(join(cwd, ".tanya/artifacts/ios/SplashScreenPattern.swift"), "import SwiftUI\n");

    const { message: result } = await runAgent({
      provider,
      prompt: "Create iOS splash.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        artifacts: [{ sourcePath: "artifacts/ios/SplashScreenPattern.swift", path: ".tanya/artifacts/ios/SplashScreenPattern.swift" }],
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift");
    expect(result).not.toContain("Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json");
  });

  it("drops prose fragments from comma-separated artifact reuse targets", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating splash.",
            toolCalls: [
              {
                id: "write-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "CosaNostra/SplashScreenView.swift", content: "import SwiftUI\n" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift, tagline, gradient, scale animation; kept the gate",
            "Artifact created: none",
            "Modified: CosaNostra/SplashScreenView.swift",
            "Verification: xcodebuild build -> passed",
            "Blocked: none",
            "",
            "### What to test manually",
            "1. Launch the app and verify the splash appears.",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Create iOS splash.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-artifact-prose-targets-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift");
    expect(result).not.toContain("tagline, gradient");
    expect(result).toContain("Manual check: Launch the app and verify the splash appears. -> required after CLI");
  });
});
