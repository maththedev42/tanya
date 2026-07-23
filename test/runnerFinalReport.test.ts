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

describe("runAgent final report recovery", () => {
  it("emits token metrics and writes a run log", async () => {
    const provider: ChatProvider = {
      id: "deepseek",
      model: "deepseek-chat",
      async *streamChat() {
        yield { usage: { promptTokens: 123, completionTokens: 45 } };
        yield { content: "Done." };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-token-log-"));
    const events: TanyaEvent[] = [];

    try {
      await runAgent({
        provider,
        prompt: "Summarize setup.",
        cwd,
        sink: async (event) => {
          events.push(event);
        },
      });

      const finalEvent = events.find((event) => event.type === "final");
      expect(finalEvent?.type === "final" ? finalEvent.metrics?.promptTokens : undefined).toBe(123);
      expect(finalEvent?.type === "final" ? finalEvent.metrics?.completionTokens : undefined).toBe(45);
      const costUsd = finalEvent?.type === "final" ? finalEvent.metrics?.costUsd : undefined;
      expect(typeof costUsd).toBe("number");
      expect(costUsd).toBeCloseTo((123 / 1_000_000) * 0.27 + (45 / 1_000_000) * 1.10);
      const logs = readdirSync(join(cwd, ".tanya", "runs")).filter((file) => file.endsWith(".json"));
      expect(logs.length).toBe(1);
      const log = JSON.parse(readFileSync(join(cwd, ".tanya", "runs", logs[0] ?? ""), "utf8")) as {
        promptTokens: number;
        completionTokens: number;
        model: string;
      };
      expect(log.promptTokens).toBe(123);
      expect(log.completionTokens).toBe(45);
      expect(log.model).toBe("deepseek-chat");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns structured tool schema errors for missing required fields", async () => {
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat() {
        yield {
          content: "Writing file.",
          toolCalls: [
            {
              id: "write-missing-content",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "README.md" }),
              },
            },
          ],
        };
      },
    };
    const events: TanyaEvent[] = [];

    await runAgent({
      provider,
      prompt: "Write readme.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-schema-missing-")),
      sink: async (event) => { events.push(event); },
      maxTurns: 1,
    });

    expect(events.some((event) =>
      event.type === "tool_result" &&
      event.ok === false &&
      event.summary === 'Missing required field: "content"'
    )).toBe(true);
  });

  it("returns structured tool schema errors for wrong required field types", async () => {
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat() {
        yield {
          content: "Writing file.",
          toolCalls: [
            {
              id: "write-wrong-type",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: 123, content: "demo" }),
              },
            },
          ],
        };
      },
    };
    const events: TanyaEvent[] = [];

    await runAgent({
      provider,
      prompt: "Write readme.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-schema-type-")),
      sink: async (event) => { events.push(event); },
      maxTurns: 1,
    });

    expect(events.some((event) =>
      event.type === "tool_result" &&
      event.ok === false &&
      event.summary === 'Field "path" must be string, got number'
    )).toBe(true);
  });

  it("asks for a coding final report when the model stops without one", async () => {
    const provider = makeProvider([
      "The existing setup looks good.",
      "Verification-only: existing setup satisfied\nVerification: xcodebuild -list -> passed\nNo blockers.",
    ]);
    const events: TanyaEvent[] = [];

    const { message: result } = await runAgent({
      provider,
      prompt: "Verify setup.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-report-")),
      sink: async (event) => { events.push(event); },
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(provider.requests.length).toBeGreaterThanOrEqual(2);
    expect(provider.requests[1]?.messages.at(-1)?.content).toContain("produce the final coding report");
    expect(result).toContain("Verification-only: existing setup satisfied");
    expect(events.some((event) => event.type === "final")).toBe(true);
  });

  it("does not report files from failed patch attempts as modified", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Trying a patch.",
            toolCalls: [
              {
                id: "bad-patch",
                type: "function",
                function: {
                  name: "apply_patch",
                  arguments: JSON.stringify({
                    patch: "--- a/App/Setup.swift\n+++ b/App/Setup.swift\n@@ -99,1 +99,1 @@\n-missing\n+changed\n",
                  }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: "Verification-only: existing setup satisfied\nVerification: existing setup check -> passed\nModified: none",
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Verify setup.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-failed-patch-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Modified: none");
    expect(result).not.toContain("Modified: App/Setup.swift");
  });

  it("adds targeted iOS splash repair instructions after validation catches prompt contract violations", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating splash with the required high-level tool.",
            toolCalls: [
              {
                id: "create-splash",
                type: "function",
                function: {
                  name: "create_ios_splash",
                  arguments: JSON.stringify({
                    viewPath: "CosaNostra/SplashScreenView.swift",
                    assetSetDir: "CosaNostra/Assets.xcassets/SplashIcon.imageset",
                    brandHex: "#A52A2A",
                    durationMs: 1200,
                  }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Accidentally adding prohibited details.",
            toolCalls: [
              {
                id: "write-bad-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "CosaNostra/SplashScreenView.swift",
                    content: [
                      "import SwiftUI",
                      "struct SplashScreenView: View {",
                      "  @State private var isReady = false",
                      "  var body: some View {",
                      "    ZStack {",
                      "      LinearGradient(colors: [.red, .black], startPoint: .top, endPoint: .bottom)",
                      "      Image(\"SplashIcon\").scaleEffect(isReady ? 1 : 0.9)",
                      "      Text(\"Cosa Nostra\")",
                      "    }",
                      "    .onAppear { Task { try? await Task.sleep(nanoseconds: 1); isReady = true } }",
                      "  }",
                      "}",
                    ].join("\n"),
                  }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 3) {
          yield {
            content: [
              "Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift",
              "Artifact created: none",
              "Modified: CosaNostra/SplashScreenView.swift",
              "Modified: CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
              "Verification: xcodebuild build -> passed",
              "Blocked: none",
            ].join("\n"),
          };
          return;
        }
        if (provider.requests.length === 4) {
          yield {
            content: "Applying validation repair.",
            toolCalls: [
              {
                id: "fix-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "CosaNostra/SplashScreenView.swift",
                    content: [
                      "import SwiftUI",
                      "struct SplashScreenView: View {",
                      "  @State private var isReady = false",
                      "  var body: some View {",
                      "    ZStack {",
                      "      Color(red: 165/255, green: 42/255, blue: 42/255)",
                      "      Image(\"SplashIcon\").opacity(isReady ? 1 : 0)",
                      "    }",
                      "    .onAppear { Task { try? await Task.sleep(nanoseconds: 1); isReady = true } }",
                      "  }",
                      "}",
                    ].join("\n"),
                  }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 5) {
          yield {
            content: "Rerunning verification after repair.",
            toolCalls: [
              {
                id: "verify-repair",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "echo xcodebuild ok" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift",
            "Artifact created: none",
            "Modified: CosaNostra/SplashScreenView.swift",
            "Modified: CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
            "Verification: echo xcodebuild ok -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-ios-splash-repair-"));
    const memoryHome = mkdtempSync(join(tmpdir(), "tanya-repair-memory-"));
    const previousMemoryHome = process.env.TANYA_MEMORY_HOME;
    process.env.TANYA_MEMORY_HOME = memoryHome;
    mkdirSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset"), { recursive: true });
    writeFileSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json"), "{}");

    try {
      const { message: result } = await runAgent({
        provider,
        prompt: "Create iOS splash screen with solid background. No taglines, no text. Brief fade-in animation on the icon, nothing else.",
        cwd,
        sink: async () => {},
        runContext: {
          task: { kind: "coding", title: "Splash Screen — iOS" },
          expected_report: { verification: true, artifact_reuse: true },
          metadata: {
            validationPrompt: "Create iOS splash screen with solid background. No taglines, no text. Brief fade-in animation on the icon, nothing else.",
            caller: "test",
          },
        },
      });

      const repairPrompt = String(provider.requests[3]?.messages.at(-1)?.content ?? "");
      expect(repairPrompt).toContain("Repair attempt 1 of 2");
      expect(repairPrompt).toContain("remove LinearGradient/RadialGradient/AngularGradient");
      expect(repairPrompt).toContain("remove all Text(...) views");
      expect(repairPrompt).toContain("remove pulse, scale, rotation");
      expect(result).toContain("Blocked: none");
      const memory = await readRepairRunMemory();
      expect(memory).toHaveLength(1);
      expect(memory[0]?.outcome).toBe("passed");
      expect(memory[0]?.attempts[0]?.issueIds).toEqual(expect.arrayContaining([
        "ios-splash-solid-background-violated",
        "ios-splash-text-forbidden",
      ]));
    } finally {
      if (previousMemoryHome === undefined) {
        delete process.env.TANYA_MEMORY_HOME;
      } else {
        process.env.TANYA_MEMORY_HOME = previousMemoryHome;
      }
    }
  });

  it("does not keep failed file copy setup after a later copy succeeds", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Copying the splash asset.",
            toolCalls: [
              {
                id: "failed-cp",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "cp brand/icons/android/xxxhdpi-192x192.png android/app/src/main/res/drawable/ic_splash_logo.png" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Creating the directory and retrying.",
            toolCalls: [
              {
                id: "passed-cp",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "mkdir -p android/app/src/main/res/drawable && cp brand/icons/android/xxxhdpi-192x192.png android/app/src/main/res/drawable/ic_splash_logo.png" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/android/SplashScreenPattern.kt -> app/src/main/java/com/example/SplashScreen.kt",
            "Artifact created: none",
            "Modified: android/app/src/main/res/drawable/ic_splash_logo.png",
            "Verification: mkdir -p android/app/src/main/res/drawable && cp brand/icons/android/xxxhdpi-192x192.png android/app/src/main/res/drawable/ic_splash_logo.png -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-copy-recovery-"));
    mkdirSync(join(cwd, "brand/icons/android"), { recursive: true });
    mkdirSync(join(cwd, "android/app/src/main/res"), { recursive: true });
    writeFileSync(join(cwd, "brand/icons/android/xxxhdpi-192x192.png"), "png");
    execFileSync("git", ["init"], { cwd });

    const { message: result } = await runAgent({
      provider,
      prompt: "Copy Android splash asset.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        artifacts: [{ sourcePath: "artifacts/android/SplashScreenPattern.kt", path: "artifacts/android/SplashScreenPattern.kt" }],
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Blocked: none");
    expect(result).not.toContain("failed verification: cp brand/icons/android/xxxhdpi-192x192.png");
  });

  it("normalizes bold machine-readable report labels", async () => {
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
            "- **Artifact reused:** `artifacts/ios/SplashScreenPattern.swift` → `CosaNostra/SplashScreenView.swift` (adapted)",
            "- **Artifact created:** none",
            "- `Modified: CosaNostra/SplashScreenView.swift`",
            "- `Verification: xcodebuild build -> passed`",
            "- **Manual check:** Run on a simulator to verify the splash icon renders",
            "- **Blocked:** none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Create iOS splash.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-bold-report-labels-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift");
    expect(result).toContain("Artifact created: none");
    expect(result).toContain("Manual check: Run on a simulator to verify the splash icon renders -> required after CLI");
    expect(result).not.toContain("**Artifact reused:**");
  });

  it("adds deterministic manual check lines from manual testing sections", async () => {
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
            "Artifact created: none",
            "Modified: app/src/main/java/SplashScreen.kt",
            "Verification: ./gradlew assembleDebug --no-daemon -> passed",
            "Blocked: none",
            "",
            "### Manual testing needed",
            "1. Launch on an emulator and verify the splash renders.",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Create Android splash.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-manual-testing-section-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Manual check: Launch on an emulator and verify the splash renders. -> required after CLI");
  });

  it("appends a structured report and validator findings for coding tasks", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating a weak iOS splash.",
            toolCalls: [
              {
                id: "write-splash",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "CosaNostra/SplashScreenView.swift",
                    content: "import SwiftUI\nstruct SplashScreenView: View { var body: some View { Color.accentColor } }\n",
                  }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: artifacts/ios/SplashScreenPattern.swift -> CosaNostra/SplashScreenView.swift",
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
      prompt: "Create Splash Screen for iOS.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-structured-report-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding", title: "Generic coding task" },
        expected_report: { verification: true, artifact_reuse: true },
      },
    });

    expect(result).toContain("Tanya structured report:");
    expect(result).toContain("\"modified\"");
    expect(result).toContain("\"blocked\"");
    expect(result).toContain("Blocked: core-verification-missing");
    expect(result).not.toContain("ios-splash-icon-image");
    expect(result).not.toContain("ios-splash-accentcolor-only");
  });

  it("records golden task memory when caller opts in", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Writing README.",
            toolCalls: [
              {
                id: "write-readme",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "README.md", content: "# Demo\n" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Verifying README patch.",
            toolCalls: [
              {
                id: "verify-readme",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "echo ok" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none",
            "Artifact created: none",
            "Modified: README.md",
            "Verification: echo ok -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-golden-memory-"));

    await runAgent({
      provider,
      prompt: "Patch README.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding", title: "Patch README" },
        expected_report: { verification: true },
        metadata: { goldenTaskCandidate: true, caller: "test" },
      },
    });

    const memory = readFileSync(join(cwd, ".tanya/memory/golden-tasks.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { outcome: string; task: { title?: string } });
    expect(memory).toHaveLength(1);
    expect(memory[0]?.outcome).toBe("passed");
    expect(memory[0]?.task.title).toBe("Patch README");
  });
});
