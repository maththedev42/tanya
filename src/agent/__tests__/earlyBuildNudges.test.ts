import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../runner";
import { detectProjectGenerator } from "../projectGenerators";
import type { ChatProvider, ToolCall } from "../../providers/types";
import type { TanyaEvent } from "../../events/types";

// Early build-hygiene nudges (PROMPT B2 items 3–4): fired at WRITE time, not
// report time — the audited run created 6 new .swift files in an xcodegen
// repo, never ran `xcodegen generate`, never built, and died before any
// report-time gate could arm.

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(withProjectYml: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "tanya-nudge-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@e.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  if (withProjectYml) writeFileSync(join(dir, "project.yml"), "name: App\n");
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function toolOutputs(events: TanyaEvent[]): string[] {
  return events
    .filter((event): event is Extract<TanyaEvent, { type: "tool_result" }> => event.type === "tool_result")
    .map((event) => JSON.stringify(event));
}

describe("detectProjectGenerator", () => {
  it("detects xcodegen via project.yml and tuist via Project.swift; null otherwise", () => {
    const xcodegenDir = initRepo(true);
    expect(detectProjectGenerator(xcodegenDir)?.id).toBe("xcodegen");
    const plainDir = initRepo(false);
    expect(detectProjectGenerator(plainDir)).toBeNull();
    writeFileSync(join(plainDir, "Project.swift"), "// tuist\n");
    expect(detectProjectGenerator(plainDir)?.id).toBe("tuist");
  });
});

describe("generator-aware new-file nudge", () => {
  it("nudges `xcodegen generate` when a NEW .swift file lands in a project.yml repo", async () => {
    const dir = initRepo(true);
    const events: TanyaEvent[] = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        const wrote = input.messages.some((m) => m.role === "tool");
        if (!wrote) {
          yield { toolCalls: [toolCall("c1", "write_file", { path: "Sources/NewView.swift", content: "import SwiftUI\n" })] };
          return;
        }
        yield { content: "Done." };
      },
    };
    await runAgent({ provider, prompt: "add the view", cwd: dir, sink: async (e) => { events.push(e); }, maxTurns: 3 });

    const outputs = toolOutputs(events).join("\n");
    expect(outputs).toContain("xcodegen generate");
    expect(outputs).toContain("NewView.swift");
  }, 30_000);

  it("does NOT nudge for a doc file, nor in a repo without a generator", async () => {
    const dir = initRepo(false);
    const events: TanyaEvent[] = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        const wrote = input.messages.some((m) => m.role === "tool");
        if (!wrote) {
          yield { toolCalls: [toolCall("c1", "write_file", { path: "New.swift", content: "let a = 1\n" })] };
          return;
        }
        yield { content: "Done." };
      },
    };
    await runAgent({ provider, prompt: "add file", cwd: dir, sink: async (e) => { events.push(e); }, maxTurns: 3 });
    expect(toolOutputs(events).join("\n")).not.toContain("xcodegen generate");
  }, 30_000);
});

describe("first-build-early nudge", () => {
  it("nudges after the 4th changed source file with zero builds run", async () => {
    const dir = initRepo(false);
    const events: TanyaEvent[] = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        const wrote = input.messages.some((m) => m.role === "tool");
        if (!wrote) {
          yield {
            toolCalls: [
              toolCall("c1", "write_file", { path: "a.ts", content: "export {};\n" }),
              toolCall("c2", "write_file", { path: "b.ts", content: "export {};\n" }),
              toolCall("c3", "write_file", { path: "c.ts", content: "export {};\n" }),
              toolCall("c4", "write_file", { path: "d.ts", content: "export {};\n" }),
            ],
          };
          return;
        }
        yield { content: "Done." };
      },
    };
    await runAgent({ provider, prompt: "write the files", cwd: dir, sink: async (e) => { events.push(e); }, maxTurns: 3 });

    const outputs = toolOutputs(events);
    const nudged = outputs.filter((output) => output.includes("without running any build or test"));
    // Fires exactly once, on the write that crossed the threshold.
    expect(nudged).toHaveLength(1);
    expect(outputs.indexOf(nudged[0]!)).toBe(outputs.length - 1);
  }, 30_000);

  it("stays silent below the threshold", async () => {
    const dir = initRepo(false);
    const events: TanyaEvent[] = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        const wrote = input.messages.some((m) => m.role === "tool");
        if (!wrote) {
          yield {
            toolCalls: [
              toolCall("c1", "write_file", { path: "a.ts", content: "export {};\n" }),
              toolCall("c2", "write_file", { path: "b.ts", content: "export {};\n" }),
            ],
          };
          return;
        }
        yield { content: "Done." };
      },
    };
    await runAgent({ provider, prompt: "write the files", cwd: dir, sink: async (e) => { events.push(e); }, maxTurns: 3 });
    expect(toolOutputs(events).join("\n")).not.toContain("without running any build or test");
  }, 30_000);
});
