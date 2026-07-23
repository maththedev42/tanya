import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../runner";
import type { ChatProvider, ToolCall } from "../../providers/types";

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

// A file-writing coding run (writes a file, then says it's done).
function makeWritingProvider(): ChatProvider {
  let calls = 0;
  return {
    id: "test",
    model: "test-model",
    async *streamChat() {
      calls += 1;
      if (calls === 1) {
        yield { toolCalls: [toolCall("c1", "write_file", { path: "Main.swift", content: 'print("hi")\n' })] };
        return;
      }
      yield { content: "All done — the app builds and runs." };
    },
  };
}

// A pure conversational turn: no tools, no file writes.
function makeChatProvider(): ChatProvider {
  return {
    id: "test",
    model: "test-model",
    async *streamChat() {
      yield { content: "The auth flow uses a bearer token refreshed on 401." };
    },
  };
}

describe("interactive run mode (intent gating — gate-escape E1)", () => {
  it("a pure chat turn stays conversational — no machine coding-report", async () => {
    const result = await runAgent({
      provider: makeChatProvider(),
      prompt: "how does the auth flow work?",
      cwd: mkdtempSync(join(tmpdir(), "tanya-interactive-")),
      sink: async () => {},
      runContext: { task: { kind: "coding" } },
      interactive: true,
      maxTurns: 6,
    });
    expect(result.message).toContain("bearer token");
    expect(result.message).not.toMatch(/Verification:\s*.+->/);
    expect(result.message).not.toMatch(/^Modified:/m);
    expect(result.message).not.toMatch(/TANYA RESULT:/);
  });

  it("a coding turn that WROTE a file now surfaces the honest report + verdict (concise, no JSON dump)", async () => {
    const result = await runAgent({
      provider: makeWritingProvider(),
      prompt: "build a calculator app",
      cwd: mkdtempSync(join(tmpdir(), "tanya-interactive-")),
      sink: async () => {},
      runContext: { task: { kind: "coding" } },
      interactive: true,
      maxTurns: 6,
    });
    // The conversational text is preserved…
    expect(result.message).toContain("All done");
    // …but the run no longer lies quietly: the report + verdict are surfaced.
    expect(result.message).toMatch(/^Modified: Main\.swift/m);
    expect(result.message).toMatch(/TANYA RESULT:/);
    // Interactive reports are concise — no raw JSON manifest dump flooding the chat.
    expect(result.message).not.toContain("Tanya manifest:");
  });
});
