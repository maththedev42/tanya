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

describe("runAgent final report — verification recovery", () => {
  it("returns a fallback coding report when tool turns are exhausted after verification", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        yield {
          content: "Checking build.",
          toolCalls: [
            {
              id: `call-${provider.requests.length}`,
              type: "function",
              function: {
                name: "run_shell",
                arguments: JSON.stringify({ script: "echo ok" }),
              },
            },
          ],
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Verify setup.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-limit-report-")),
      sink: async () => {},
      maxTurns: 1,
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Stopped after reaching the tool-turn limit.");
    expect(result).toContain("Verification-only: existing setup satisfied");
    expect(result).toContain("Verification: echo ok -> passed");
  });

  it("reruns duplicate verification commands after a file mutation", async () => {
    const toolSummaries: string[] = [];
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Write v1.",
            toolCalls: [
              {
                id: "write-v1",
                type: "function",
                function: { name: "write_file", arguments: JSON.stringify({ path: "Info.plist", content: "v1\n" }) },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Verify v1.",
            toolCalls: [
              {
                id: "verify-v1",
                type: "function",
                function: { name: "run_shell", arguments: JSON.stringify({ script: "cat Info.plist" }) },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 3) {
          yield {
            content: "Write v2.",
            toolCalls: [
              {
                id: "write-v2",
                type: "function",
                function: { name: "write_file", arguments: JSON.stringify({ path: "Info.plist", content: "v2\n" }) },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 4) {
          yield {
            content: "Verify v2.",
            toolCalls: [
              {
                id: "verify-v2",
                type: "function",
                function: { name: "run_shell", arguments: JSON.stringify({ script: "cat Info.plist" }) },
              },
            ],
          };
          return;
        }
        yield {
          content: [
            "Artifact reused: none",
            "Artifact created: none",
            "Modified: Info.plist",
            "Verification: cat Info.plist -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    await runAgent({
      provider,
      prompt: "Update plist.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-verify-after-mutation-")),
      sink: async (event) => {
        if (event.type === "tool_result") toolSummaries.push(event.summary);
      },
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(toolSummaries.filter((summary) => summary.includes("Skipped duplicate verification"))).toHaveLength(0);
  });

  it("skips an identical command that keeps failing, and re-arms it after a file mutation", async () => {
    const results: Array<{ id: string; summary: string }> = [];
    // The 2026-05-09 `go build ./...` spiral: the same command fails over and
    // over with no code change in between. After REPEATED_FAILURE_ATTEMPT_LIMIT
    // (3) failures the runner skips it; editing a file re-arms it.
    const failing = (id: string) => ({
      id,
      type: "function" as const,
      function: { name: "run_shell", arguments: JSON.stringify({ script: "exit 1" }) },
    });
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        const n = provider.requests.length;
        if (n <= 3) { yield { content: `attempt ${n}`, toolCalls: [failing(`attempt-${n}`)] }; return; }
        if (n === 4) { yield { content: "attempt 4", toolCalls: [failing("attempt-4")] }; return; }
        if (n === 5) {
          yield {
            content: "edit",
            toolCalls: [{ id: "edit-1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "main.go", content: "package main\n" }) } }],
          };
          return;
        }
        if (n === 6) { yield { content: "attempt 5", toolCalls: [failing("attempt-5")] }; return; }
        yield { content: ["Modified: main.go", "Blocked: build fails"].join("\n") };
      },
    };

    await runAgent({
      provider,
      prompt: "Fix the build.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-repeat-fail-")),
      sink: async (event) => {
        if (event.type === "tool_result") results.push({ id: event.id, summary: event.summary });
      },
      runContext: { task: { kind: "coding" } },
    });

    const summaryFor = (id: string) => results.find((r) => r.id === id)?.summary ?? "";
    // First three run for real (fail); the fourth identical unchanged attempt is skipped.
    for (const id of ["attempt-1", "attempt-2", "attempt-3"]) {
      expect(summaryFor(id)).not.toContain("Skipped repeated failing command");
    }
    expect(summaryFor("attempt-4")).toContain("Skipped repeated failing command");
    // The write_file mutation re-arms the command, so the next identical run executes again.
    expect(summaryFor("attempt-5")).not.toContain("Skipped repeated failing command");
  });

  it("stops a stalled run that burns tokens without making progress (token-runaway backstop)", async () => {
    // The 2026-05-09 runaway: a stalled run kept re-sending a large context,
    // ballooning to millions of prompt tokens before the turn-based stall stop
    // fired at the soft-budget floor. With a low ceiling, the token backstop
    // halts it after 2 no-progress turns instead of grinding to turn 40.
    process.env.TANYA_MAX_STALL_TOKENS = "150";
    try {
      const provider: ChatProvider & { requests: ChatRequest[] } = {
        id: "test",
        model: "test-model",
        requests: [],
        async *streamChat(input: ChatRequest) {
          provider.requests.push({ ...input, messages: [...input.messages] });
          const n = provider.requests.length;
          // Each turn burns 100 prompt tokens and makes NO progress (a failing
          // command), so lastProgressTurn never advances.
          yield {
            content: `attempt ${n}`,
            usage: { promptTokens: 100, completionTokens: 1 },
            toolCalls: [{ id: `fail-${n}`, type: "function", function: { name: "run_shell", arguments: JSON.stringify({ script: "exit 1" }) } }],
          };
        },
      };

      const result = await runAgent({
        provider,
        prompt: "Fix the build.",
        cwd: mkdtempSync(join(tmpdir(), "tanya-runner-token-runaway-")),
        sink: async () => {},
        runContext: { task: { kind: "coding" } },
      });

      expect(result.manifest.blockers).toContain("token budget exhausted before final completion (stalled with no progress)");
      // Halted long before the 40-turn floor: the trip itself takes ~2 stalled
      // turns, plus the fixed wrap-up window (commit + final report chance)
      // granted before the hard stop — never more.
      expect(provider.requests.length).toBeLessThan(6 + WRAP_UP_TURNS);
      // The wall was announced to the model: the last request carries the
      // injected wrap-up directive as a user message.
      const lastRequest = provider.requests[provider.requests.length - 1]!;
      expect(lastRequest.messages.some(
        (message) => message.role === "user" && typeof message.content === "string" && message.content.includes("BUDGET WALL"),
      )).toBe(true);
    } finally {
      delete process.env.TANYA_MAX_STALL_TOKENS;
    }
  });

  it("skips duplicate successful build and test verification commands", async () => {
    let shellRuns = 0;
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length <= 4) {
          const script = provider.requests.length === 1
            ? "printf '#!/bin/sh\\necho ok\\n' > xcodebuild && chmod +x xcodebuild && PATH=$PWD:$PATH xcodebuild build -scheme App"
            : provider.requests.length === 2
              ? "PATH=$PWD:$PATH xcodebuild build -scheme App"
              : provider.requests.length === 3
                ? "PATH=$PWD:$PATH xcodebuild test -scheme App"
                : "PATH=$PWD:$PATH xcodebuild test -scheme App";
          yield {
            content: "Verifying build.",
            toolCalls: [
              {
                id: `call-${provider.requests.length}`,
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script }),
                },
              },
            ],
          };
          shellRuns += 1;
          return;
        }
        yield {
          content: "Verification-only: existing setup satisfied\nVerification: xcodebuild build -scheme App -> passed\nModified: none",
        };
      },
    };

    const toolSummaries: string[] = [];
    const { message: result } = await runAgent({
      provider,
      prompt: "Verify setup.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-duplicate-build-")),
      sink: async (event) => {
        if (event.type === "tool_result") toolSummaries.push(event.summary);
      },
      maxTurns: 4,
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(shellRuns).toBe(4);
    expect(result).toContain("Verification-only: existing setup satisfied");
    expect(toolSummaries.filter((summary) => summary.includes("Skipped duplicate verification"))).toHaveLength(2);
  });

  it("does not treat an unsafe piped xcodebuild command as duplicate coverage for a direct build", async () => {
    let shellRuns = 0;
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length <= 2) {
          const script = provider.requests.length === 1
            ? "printf '#!/bin/sh\\necho ok\\n' > xcodebuild && chmod +x xcodebuild && PATH=$PWD:$PATH xcodebuild build -scheme App 2>&1 | tail -5"
            : "PATH=$PWD:$PATH xcodebuild build -scheme App";
          yield {
            content: "Verifying build.",
            toolCalls: [
              {
                id: `call-${provider.requests.length}`,
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script }),
                },
              },
            ],
          };
          shellRuns += 1;
          return;
        }
        yield {
          content: "Verification-only: existing setup satisfied\nVerification: xcodebuild build -scheme App -> passed\nModified: none",
        };
      },
    };

    const toolSummaries: string[] = [];
    const { message: result } = await runAgent({
      provider,
      prompt: "Verify setup.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-xcodebuild-pipe-")),
      sink: async (event) => {
        if (event.type === "tool_result") toolSummaries.push(event.summary);
      },
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(shellRuns).toBe(2);
    expect(result).toContain("Verification-only: existing setup satisfied");
    expect(toolSummaries.filter((summary) => summary.includes("Skipped duplicate verification"))).toHaveLength(0);
  }, 10_000);

  it("does not keep failed Fastlane output probes as blockers after build verification recovers", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Checking Fastlane output.",
            toolCalls: [
              {
                id: "failed-grep",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "fastlane ios build 2>&1 | grep -E 'BUILD SUCCEEDED'" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Verifying with xcodebuild.",
            toolCalls: [
              {
                id: "passed-build",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "printf '#!/bin/sh\\nexit 0\\n' > xcodebuild && chmod +x xcodebuild && PATH=$PWD:$PATH xcodebuild build -scheme App" }),
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
            "Modified: none",
            "Verification-only: existing setup satisfied",
            "Verification: xcodebuild build -scheme App -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Verify iOS Fastlane setup.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-fastlane-recovery-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Blocked: none");
    expect(result).not.toContain("failed verification: fastlane ios build");
  });

  it("removes untracked Fastlane generated noise before finalizing coding reports", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Running Fastlane.",
            toolCalls: [
              {
                id: "make-fastlane-noise",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({
                    script: "mkdir -p fastlane/test_output && printf '# Generated\\n' > fastlane/README.md && printf '<testsuite />\\n' > fastlane/report.xml && printf 'log\\n' > fastlane/test_output/output.log",
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
            "Modified: none",
            "Verification-only: existing setup satisfied",
            "Verification: fastlane lanes -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-fastlane-noise-"));

    const { message: result } = await runAgent({
      provider,
      prompt: "Configure Fastlane.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(existsSync(join(cwd, "fastlane/README.md"))).toBe(false);
    expect(existsSync(join(cwd, "fastlane/report.xml"))).toBe(false);
    expect(existsSync(join(cwd, "fastlane/test_output"))).toBe(false);
    expect(result).not.toContain("Modified: fastlane/README.md");
    expect(result).not.toContain("Modified: fastlane/report.xml");
  });

  it("does not keep recovered ktlint and git add attempts as blockers", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Checking ktlint.",
            toolCalls: [
              {
                id: "failed-ktlint",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "exit 1 # ./gradlew ktlintCheck --no-daemon" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Rechecking ktlint.",
            toolCalls: [
              {
                id: "passed-ktlint",
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
        if (provider.requests.length === 3) {
          yield {
            content: "Trying git add from nested cwd.",
            toolCalls: [
              {
                id: "failed-git-add",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "git add android/app/build.gradle.kts" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 4) {
          yield {
            content: "Retrying git add from repo root.",
            toolCalls: [
              {
                id: "passed-git-add",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "true # git -C /tmp/repo add android/app/build.gradle.kts" }),
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
            "Modified: app/build.gradle.kts",
            "Verification: ./gradlew ktlintCheck --no-daemon -> passed",
            "Verification: git -C /tmp/repo add android/app/build.gradle.kts -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-ktlint-git-recovery-"));
    execFileSync("git", ["init"], { cwd });
    const { message: result } = await runAgent({
      provider,
      prompt: "Verify Android setup.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Blocked: none");
    expect(result).not.toContain("failed verification: exit 1 # ./gradlew ktlintCheck");
    expect(result).not.toContain("failed verification: git add android/app/build.gradle.kts");
  });

  it("repairs missing Android Gradle verification before finalizing", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Updating Android file.",
            toolCalls: [
              {
                id: "write-main",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "app/src/main/java/com/example/MainActivity.kt",
                    content: "package com.example\nfun ready() = true\n",
                  }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: [
              "Artifact reused: none",
              "Artifact created: none",
              "Modified: app/src/main/java/com/example/MainActivity.kt",
              "Verification: not run -> omitted",
              "Blocked: none",
            ].join("\n"),
          };
          return;
        }
        if (provider.requests.length === 3) {
          expect(input.messages.some((message) =>
            typeof message.content === "string" &&
            message.content.includes("./gradlew ktlintCheck --no-daemon")
          )).toBe(true);
          yield {
            content: "Repairing Android verification.",
            toolCalls: [
              {
                id: "assemble",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ command: "./gradlew assembleDebug --no-daemon" }),
                },
              },
              {
                id: "ktlint",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ command: "./gradlew ktlintCheck --no-daemon" }),
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
            "Modified: app/src/main/java/com/example/MainActivity.kt",
            "Verification: ./gradlew assembleDebug --no-daemon -> passed",
            "Verification: ./gradlew ktlintCheck --no-daemon -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-android-gradle-repair-"));
    writeFileSync(join(cwd, "gradlew"), "#!/bin/sh\necho BUILD SUCCESSFUL\n");
    execFileSync("chmod", ["+x", "gradlew"], { cwd });
    writeFileSync(join(cwd, "build.gradle.kts"), "plugins { id(\"org.jlleitschuh.gradle.ktlint\") version \"12.1.1\" }\n");

    const { message: result, manifest } = await runAgent({
      provider,
      prompt: "Update Android MainActivity.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding", title: "Android simple task" },
        expected_report: { verification: true },
      },
    });

    expect(manifest.validation?.passed).toBe(true);
    expect(result).toContain("Verification: ./gradlew assembleDebug --no-daemon -> passed");
    expect(result).toContain("Verification: ./gradlew ktlintCheck --no-daemon -> passed");
    expect(result).toContain("Blocked: none");
  });

  it("does not keep failed grep absence probes as blockers when the final report explains no matches", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Checking for old references.",
            toolCalls: [
              {
                id: "grep-old-references",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "grep -r \"old_color\" app/src 2>/dev/null" }),
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
            "Modified: app/src/main/java/com/example/AppTheme.kt",
            "Verification: grep -r \"old_color\" app/src 2>/dev/null -> failed",
            "No old references remain; no matches were found.",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-grep-absence-"));
    mkdirSync(join(cwd, "app/src"), { recursive: true });

    const { message: result } = await runAgent({
      provider,
      prompt: "Remove old color references.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Blocked: none");
    expect(result).not.toContain("failed verification: grep -r \"old_color\"");
  });

  it("does not keep failed exploratory project probes as blockers after a stronger build passes", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Checking Xcode project entries.",
            toolCalls: [
              {
                id: "failed-project-grep",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "grep -c \"Theme/Colors.swift\" CosaNostra.xcodeproj/project.pbxproj" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Running stronger build verification.",
            toolCalls: [
              {
                id: "passed-xcodebuild",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "printf '#!/bin/sh\\nexit 0\\n' > xcodebuild && chmod +x xcodebuild && PATH=$PWD:$PATH xcodebuild build -scheme App -destination 'generic/platform=iOS Simulator'" }),
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
            "Modified: CosaNostra/Theme/Colors.swift",
            "Verification: xcodebuild build -scheme App -destination 'generic/platform=iOS Simulator' -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Build iOS foundation.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-project-probe-recovery-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding", title: "Fundações - iOS" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Blocked: none");
    expect(result).not.toContain("failed verification: grep -c \"Theme/Colors.swift\"");
  });

  it("does not keep a failed SwiftLint config existence probe after SwiftLint passes", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Checking config.",
            toolCalls: [
              {
                id: "failed-ls",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "ls -la .swiftlint.yml 2>&1; ls -la ../.swiftlint.yml 2>&1" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: "Running SwiftLint.",
            toolCalls: [
              {
                id: "passed-swiftlint",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "printf '#!/bin/sh\\nexit 0\\n' > swiftlint && chmod +x swiftlint && PATH=$PWD:$PATH swiftlint --config .swiftlint.yml" }),
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
            "Modified: .swiftlint.yml",
            "Verification: swiftlint --config .swiftlint.yml -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const { message: result } = await runAgent({
      provider,
      prompt: "Verify iOS setup.",
      cwd: mkdtempSync(join(tmpdir(), "tanya-runner-swiftlint-recovery-")),
      sink: async () => {},
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(result).toContain("Blocked: none");
    expect(result).not.toContain("failed verification: ls -la .swiftlint.yml");
  });

  it("finalizes when the model repeatedly asks for the same duplicate verification", async () => {
    let shellRuns = 0;
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        const script = provider.requests.length === 1
          ? "printf '#!/bin/sh\\necho ok\\n' > xcodebuild && chmod +x xcodebuild && PATH=$PWD:$PATH xcodebuild build -scheme App"
          : "PATH=$PWD:$PATH xcodebuild build -scheme App";
        yield {
          content: "Checking build.",
          toolCalls: [
            {
              id: `call-${provider.requests.length}`,
              type: "function",
              function: {
                name: "run_shell",
                arguments: JSON.stringify({ script }),
              },
            },
          ],
        };
        shellRuns += 1;
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-duplicate-finalize-"));
    const { message: result } = await runAgent({
      provider,
      prompt: "Verify setup.",
      cwd,
      sink: async () => {},
      maxTurns: 8,
      runContext: {
        task: { kind: "coding" },
        expected_report: { verification: true },
      },
    });

    expect(shellRuns).toBe(3);
    expect(result).toContain("Finalized after repeated duplicate verification requests.");
    expect(result).toContain("Verification-only: existing setup satisfied");
  });

  it("records verification for run_shell command alias calls", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Checking with command alias.",
            toolCalls: [
              {
                id: "alias-check",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ command: "printf ok", timeoutMs: 5_000 }),
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
            "Verification: printf ok -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };
    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-shell-alias-verification-"));

    try {
      const { message: result } = await runAgent({
        provider,
        prompt: "Verify existing setup.",
        cwd,
        sink: async () => {},
        runContext: {
          task: { kind: "coding" },
          expected_report: { verification: true },
        },
      });

      expect(result).toContain("Verification: printf ok -> passed");
      expect(result).not.toContain("core-verification-missing");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("treats missing explicit npm install verification as repairable error", async () => {
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "test-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        if (provider.requests.length === 1) {
          yield {
            content: "Patching backend docs.",
            toolCalls: [
              {
                id: "write-doc",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "README.md", content: "# Backend\n" }),
                },
              },
              {
                id: "probe-install",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "ls node_modules/.package-lock.json" }),
                },
              },
            ],
          };
          return;
        }
        if (provider.requests.length === 2) {
          yield {
            content: [
              "Artifact reused: none",
              "Artifact created: none",
              "Modified: README.md",
              "Verification: ls node_modules/.package-lock.json -> passed",
              "Blocked: none",
            ].join("\n"),
          };
          return;
        }
        if (provider.requests.length === 3) {
          yield {
            content: "Running the missing exact install verification.",
            toolCalls: [
              {
                id: "npm-install",
                type: "function",
                function: {
                  name: "run_shell",
                  arguments: JSON.stringify({ script: "npm install" }),
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
            "Verification: npm install -> passed",
            "Blocked: none",
          ].join("\n"),
        };
      },
    };

    const cwd = mkdtempSync(join(tmpdir(), "tanya-runner-npm-install-repair-"));
    writeFileSync(join(cwd, "package.json"), "{\"scripts\":{}}\n");
    mkdirSync(join(cwd, "node_modules"), { recursive: true });
    writeFileSync(join(cwd, "node_modules/.package-lock.json"), "{}\n");

    const { message: result } = await runAgent({
      provider,
      prompt: "Patch backend docs and verify npm install.",
      cwd,
      sink: async () => {},
      runContext: {
        task: { kind: "coding", title: "Backend docs" },
        expected_report: { verification: true },
        verification: { commands: ["npm install"] },
      },
    });

    const repairPrompt = String(provider.requests[2]?.messages.at(-1)?.content ?? "");
    expect(repairPrompt).toContain("Requested verification command was not captured exactly: npm install");
    expect(repairPrompt).toContain("Do not substitute file-existence probes");
    expect(result).toContain("Verification: npm install -> passed");
  });
});
