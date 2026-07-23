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

describe("runAgent final report — workspace & fallback reports", () => {
  it("filters Xcode DerivedData from deterministic changed-file reports", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        yield {
          content: "Writing setup and build output.",
          toolCalls: [
            {
              id: "write-config",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: ".swiftlint.yml", content: "disabled_rules: []\n" }),
              },
            },
            {
              id: "write-derived-data",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "DerivedData-Build/Logs/Build/LogStoreManifest.plist", content: "generated\n" }),
              },
            },
          ],
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-derived-data-report-"));

    const { message: result } = await runAgent({
      provider,
      prompt: "Set up iOS.",
      cwd,
      sink: async () => {},
      maxTurns: 1,
      runContext: {
        task: { kind: "coding", title: "Setup Environment - iOS" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Modified: .swiftlint.yml");
    expect(result).not.toContain("Modified: DerivedData-Build");
  });

  it("uses git changes in fallback reports and ignores backup files", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        yield {
          content: "Implementing splash.",
          toolCalls: [
            {
              id: "commit-files",
              type: "function",
              function: {
                name: "run_shell",
                arguments: JSON.stringify({
                  script: [
                    "mkdir -p App/Assets.xcassets/SplashIcon.imageset",
                    "printf 'app\\n' > App/CosaNostraApp.swift",
                    "printf 'splash\\n' > App/SplashScreenView.swift",
                    "printf '{}\\n' > App/Assets.xcassets/SplashIcon.imageset/Contents.json",
                    "printf '{}\\n' > App/Assets.xcassets/SplashIcon.imageset/Contents.json.orig",
                    "git add App/CosaNostraApp.swift App/SplashScreenView.swift App/Assets.xcassets/SplashIcon.imageset/Contents.json",
                    "git commit -m splash",
                  ].join(" && "),
                }),
              },
            },
          ],
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-git-report-"));
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    writeFileSync(join(cwd, "README.md"), "init\n");
    execFileSync("git", ["add", "README.md"], { cwd });
    execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });

    const events: TanyaEvent[] = [];
    const { message: result } = await runAgent({
      provider,
      prompt: "Create splash.",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 1,
      runContext: {
        task: { kind: "coding" },
        metadata: { requireCommit: true },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Modified: App/CosaNostraApp.swift");
    expect(result).toContain("Modified: App/SplashScreenView.swift");
    expect(result).toContain("Modified: App/Assets.xcassets/SplashIcon.imageset/Contents.json");
    expect(result).not.toContain("Modified: App/Assets.xcassets/SplashIcon.imageset/Contents.json.orig");
    expect(existsSync(join(cwd, "App/Assets.xcassets/SplashIcon.imageset/Contents.json.orig"))).toBe(false);
    expect(events.some((event) => event.type === "final" && (event.files ?? []).includes("App/CosaNostraApp.swift"))).toBe(true);
  });

  it("scopes git fallback reports to the current nested workspace", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        yield {
          content: "Implementing Android setup.",
          toolCalls: [
            {
              id: "commit-files",
              type: "function",
              function: {
                name: "run_shell",
                arguments: JSON.stringify({
                  script: [
                    "mkdir -p app/src/main/java ../ios/App",
                    "printf 'android\\n' > app/src/main/java/MainActivity.kt",
                    "printf 'ios\\n' > ../ios/App/SplashScreenView.swift",
                    "git -C .. add android/app/src/main/java/MainActivity.kt ios/App/SplashScreenView.swift",
                    "git -C .. commit -m platform-changes",
                  ].join(" && "),
                }),
              },
            },
          ],
        };
      },
    };
    const repo = mkdtempSync(join(tmpdir(), "tanya-runner-nested-report-"));
    mkdirSync(join(repo, "android"), { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "init\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });

    const { message: result } = await runAgent({
      provider,
      prompt: "Configure Android.",
      cwd: join(repo, "android"),
      sink: async () => {},
      maxTurns: 1,
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

    expect(result).toContain("Modified: app/src/main/java/MainActivity.kt");
    expect(result).not.toContain("Modified: ../ios/App/SplashScreenView.swift");
    expect(result).not.toContain("Modified: ios/App/SplashScreenView.swift");
    expect(result).toContain("Artifact reused: none");
    expect(result).toContain("core-artifact-provenance-missing");
  });

  it("normalizes repo-prefixed tool paths for nested workspace reports", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating file.",
            toolCalls: [
              {
                id: "write-file",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "mkdir -p app/src/main/java && printf 'android\\n' > app/src/main/java/MainActivity.kt" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Committing with repo-prefixed path.",
            toolCalls: [
              {
                id: "commit-file",
                type: "function",
                function: {
                  name: "commit_platform_changes",
                  arguments: JSON.stringify({
                    files: ["android/app/src/main/java/MainActivity.kt"],
                    message: "[Android] Add main activity",
                  }),
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
            "Modified: android/app/src/main/java/MainActivity.kt",
            "Verification: git rev-parse --short HEAD -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };
    const repo = mkdtempSync(join(tmpdir(), "tanya-runner-nested-prefixed-report-"));
    mkdirSync(join(repo, "android"), { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "init\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });

    const { message: result } = await runAgent({
      provider,
      prompt: "Configure Android.",
      cwd: join(repo, "android"),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        metadata: { requireCommit: true },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Modified: app/src/main/java/MainActivity.kt");
    expect(result).not.toContain("Modified: android/app/src/main/java/MainActivity.kt");
  });

  it("skips absolute reads outside the workspace without counting a tool error", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Reading safety rules.",
            toolCalls: [
              {
                id: "external-read",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: "/tmp/outside-workspace/safety.md" }),
                },
              },
            ],
          };
          return;
        }
        yield {
          content: "Verification-only: existing setup satisfied\nVerification: skipped external safety read -> passed\nModified: none",
        };
      },
    };

    const toolResults: TanyaEvent[] = [];
    const { message: result } = await runAgent({
      provider,
      prompt: "Verify setup.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-external-read-")),
      sink: async (event) => { toolResults.push(event); },
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Verification-only: existing setup satisfied");
    expect(toolResults.some((event) => event.type === "tool_result" && event.ok === true && event.summary.includes("Skipped external path outside workspace"))).toBe(true);
    expect(toolResults.some((event) => event.type === "final" && event.metrics?.toolErrorCount === 0)).toBe(true);
  });

  it("cleans materialized .tanya context after a successful coding run", async () => {
    const provider = makeProvider([
      [
        "Artifact reused: none",
        "Artifact created: none",
        "Verification: local check -> passed",
        "Blocked: none",
      ].join("\n"),
    ]);
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-clean-context-"));
    mkdirSync(join(cwd, ".tanya", "context"), { recursive: true });
    mkdirSync(join(cwd, ".tanya", "artifacts"), { recursive: true });
    mkdirSync(join(cwd, ".tanya", "memory"), { recursive: true });
    writeFileSync(join(cwd, ".tanya", "context", "safety.md"), "rules\n");
    writeFileSync(join(cwd, ".tanya", "artifacts", "manifest.json"), "{}\n");
    writeFileSync(join(cwd, ".tanya", "memory", "golden-tasks.jsonl"), "{}\n");

    try {
      await runAgent({
        provider,
        prompt: "Verify setup.",
        cwd,
        sink: async () => {},
        runContext: {
          task: { kind: "coding" },
          metadata: { tanyaMaterializedContext: true, keepMaterializedContext: false },
        },
      });

      expect(existsSync(join(cwd, ".tanya", "context"))).toBe(false);
      expect(existsSync(join(cwd, ".tanya", "artifacts"))).toBe(false);
      expect(existsSync(join(cwd, ".tanya", "memory"))).toBe(false);
      expect(existsSync(join(cwd, ".tanya", "runs"))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps materialized .tanya context when validation fails", async () => {
    const provider = makeProvider([
      [
        "Artifact reused: none",
        "Artifact created: none",
        "Verification: local check -> passed",
        "Blocked: none",
      ].join("\n"),
    ]);
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-keep-failed-context-"));
    mkdirSync(join(cwd, ".tanya", "artifacts", "ios"), { recursive: true });
    writeFileSync(join(cwd, ".tanya", "artifacts", "ios", "FastlaneSetup.md"), "setup\n");

    try {
      await runAgent({
        provider,
        prompt: "Set up iOS.",
        cwd,
        sink: async () => {},
        runContext: {
          task: { kind: "coding" },
          artifacts: [
            {
              path: ".tanya/artifacts/ios/FastlaneSetup.md",
              sourcePath: "artifacts/ios/FastlaneSetup.md",
              status: "available",
            },
          ],
          expected_report: { artifact_reuse: true },
          metadata: { tanyaMaterializedContext: true, keepMaterializedContext: false },
        },
      });

      expect(existsSync(join(cwd, ".tanya", "artifacts", "ios", "FastlaneSetup.md"))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps materialized .tanya context when keep mode is enabled", async () => {
    const provider = makeProvider([
      [
        "Artifact reused: none",
        "Artifact created: none",
        "Verification: local check -> passed",
        "Blocked: none",
      ].join("\n"),
    ]);
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-keep-context-"));
    mkdirSync(join(cwd, ".tanya", "context"), { recursive: true });
    writeFileSync(join(cwd, ".tanya", "context", "safety.md"), "rules\n");

    try {
      await runAgent({
        provider,
        prompt: "Verify setup.",
        cwd,
        sink: async () => {},
        runContext: {
          task: { kind: "coding" },
          metadata: { tanyaMaterializedContext: true, keepMaterializedContext: true },
        },
      });

      expect(existsSync(join(cwd, ".tanya", "context", "safety.md"))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("expands untracked directories from shell-created files in the final report", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating splash drawables.",
            toolCalls: [
              {
                id: "create-drawables",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({
                    script: [
                      "mkdir -p app/src/main/res/drawable",
                      "printf 'png' > app/src/main/res/drawable/ic_splash_logo.png",
                      "printf 'png' > app/src/main/res/drawable/ic_splash_logo_1024.png",
                    ].join(" && "),
                  }),
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
            "Modified: app/src/main/res/drawable/ic_splash_logo.png",
            "Modified: app/src/main/res/drawable/ic_splash_logo_1024.png",
            "Verification: file app/src/main/res/drawable/ic_splash_logo.png -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-untracked-dir-"));
    execFileSync("git", ["init"], { cwd });

    const { message: result } = await runAgent({
      provider,
      prompt: "Create Android splash drawables.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Modified: app/src/main/res/drawable/ic_splash_logo.png");
    expect(result).toContain("Modified: app/src/main/res/drawable/ic_splash_logo_1024.png");
  });

  it("repairs commit-required runs when a changed asset is left outside the commit", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Creating splash files.",
            toolCalls: [
              {
                id: "write-view",
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
                  arguments: JSON.stringify({ path: "CosaNostra/Assets.xcassets/SplashIcon.imageset/SplashIcon.png", content: "png\n" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Committing only the Swift file by mistake.",
            toolCalls: [
              {
                id: "commit-partial",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "git add CosaNostra/SplashScreenView.swift && git commit -m '[iOS] Add splash view'" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 3) {
          yield {
            content: [
              "Artifact reused: none",
              "Artifact created: none",
              "Modified: CosaNostra/SplashScreenView.swift",
              "Verification: git commit partial -> passed",
              "Blocked: none",
            ].join("\n"),
          };
          return;
        }
        if (provider.requests.length === 4) {
          yield {
            content: "Amending the missing asset into the task commit.",
            toolCalls: [
              {
                id: "commit-repair",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "git add CosaNostra/Assets.xcassets/SplashIcon.imageset/SplashIcon.png && git commit --amend --no-edit" }),
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
            "Modified: CosaNostra/SplashScreenView.swift",
            "Modified: CosaNostra/Assets.xcassets/SplashIcon.imageset/SplashIcon.png",
            "Verification: git commit --amend --no-edit -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-commit-repair-"));
    execFileSync("git", ["init"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    writeFileSync(join(cwd, "README.md"), "# Demo\n");
    execFileSync("git", ["add", "README.md"], { cwd });
    execFileSync("git", ["commit", "-m", "Initial"], { cwd });

    const { message: result } = await runAgent({
      provider,
      prompt: "Patch files and commit the changed files.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding", title: "Generic coding task" },
        expected_report: { verification: true, commit: true },
      },
      repairAttempts: 0,
    });

    const commitRepairPrompt = String(provider.requests[3]?.messages.at(-1)?.content ?? "");
    expect(commitRepairPrompt).toContain("not included in the task commit");
    expect(commitRepairPrompt).toContain("SplashIcon.png");
    expect(result).toContain("Modified: CosaNostra/Assets.xcassets/SplashIcon.imageset/SplashIcon.png");
  });

  it("does not report unchanged tool-touched files for commit-required runs", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Touching asset metadata and changing the splash view.",
            toolCalls: [
              {
                id: "write-unchanged-contents",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
                    content: "{}\n",
                  }),
                },
              },
              {
                id: "write-view",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "CosaNostra/SplashScreenView.swift",
                    content: "import SwiftUI\nstruct SplashScreenView: View { var body: some View { Text(\"Splash\") } }\n",
                  }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Committing the task.",
            toolCalls: [
              {
                id: "commit",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({
                    script: "git add CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json CosaNostra/SplashScreenView.swift && git commit -m '[iOS] Add splash screen'",
                  }),
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
            "Modified: CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json",
            "Modified: CosaNostra/SplashScreenView.swift",
            "Verification: git commit -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-commit-report-source-"));
    execFileSync("git", ["init"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    mkdirSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset"), { recursive: true });
    writeFileSync(join(cwd, "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json"), "{}\n");
    execFileSync("git", ["add", "CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json"], { cwd });
    execFileSync("git", ["commit", "-m", "Initial"], { cwd });

    const { message: result } = await runAgent({
      provider,
      prompt: "Patch files and commit the changed files.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding", title: "Generic coding task" },
        expected_report: { verification: true, commit: true },
      },
      repairAttempts: 0,
    });

    expect(result).toContain("Modified: CosaNostra/SplashScreenView.swift");
    expect(result).not.toContain("Modified: CosaNostra/Assets.xcassets/SplashIcon.imageset/Contents.json");
  });
});
