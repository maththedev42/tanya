import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../runner";
import type { ChatProvider, ChatRequest, ToolCall } from "../../providers/types";

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

const CODING_REPORT = [
  "Modified: Main.swift",
  "Verification: swiftc Main.swift -> passed",
  "Artifact reused: none",
  "Artifact created: none",
  "Blocked: none",
].join("\n");

// A coding run for an app-shaped task ("calculator") that writes code and then
// reports done WITHOUT ever running `tanya test-app`. The definition-of-done
// gate must nudge the agent once to verify behaviour — but, because the build is
// green and nothing actually failed, the run must still finalize PASSED (a
// working-but-untested app is never false-FAILed).
function makeProvider(seen: string[][]): ChatProvider {
  let calls = 0;
  return {
    id: "test",
    model: "test-model",
    async *streamChat(input: ChatRequest) {
      calls += 1;
      seen.push(input.messages.map((m) => (typeof m.content === "string" ? m.content : "")));
      if (calls === 1) {
        yield { toolCalls: [toolCall("c1", "write_file", { path: "Main.swift", content: 'print("hi")\n' })] };
        return;
      }
      yield { content: CODING_REPORT };
    },
  };
}

describe("definition-of-done runtime gate (runner)", () => {
  it("nudges once to run the runtime test, then still finalizes PASSED", async () => {
    const seen: string[][] = [];
    const result = await runAgent({
      provider: makeProvider(seen),
      prompt: "build an iOS calculator app",
      cwd: mkdtempSync(join(tmpdir(), "tanya-dod-runner-")),
      sink: async () => {},
      runContext: { task: { kind: "coding" } },
      interactive: false,
      maxTurns: 8,
    });

    const nudged = seen.some((msgs) => msgs.some((content) => /tanya test-app --tier1/.test(content)));
    expect(nudged).toBe(true);
    // Never false-FAIL a working app just because it wasn't runtime-tested.
    expect(result.message).toMatch(/TANYA RESULT:\s*PASSED/i);
    expect(result.manifest.runtimeUnverified).toBe(true);
  });
});
