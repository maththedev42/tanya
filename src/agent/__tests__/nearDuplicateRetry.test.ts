import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../runner";
import type { TanyaEvent } from "../../events/types";
import type { ChatProvider, ChatRequest, ToolCall } from "../../providers/types";

// Near-duplicate retry breaker: three DIFFERENT commands (evading the
// exact-label repeated-failure guard, which only fires on byte-identical
// labels) that share the same underlying binary and produce byte-identical
// failure output should still get flagged by the 3rd occurrence — the shape
// of the observed stall (three grep variants hunting one missing symbol).

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function toolResultOutputs(events: TanyaEvent[]): string[] {
  return events
    .filter((event): event is Extract<TanyaEvent, { type: "tool_result" }> => event.type === "tool_result")
    .map((event) => String(event.output ?? ""));
}

describe("near-duplicate retry breaker", () => {
  it("nudges on the 3rd distinct-but-same-failure command, without skipping any of them", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-near-dup-"));
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        requests.push(input);
        if (requests.length === 1) {
          // Three DIFFERENT labels (different args), same binary, same
          // (empty) failure output -> same fingerprint.
          yield {
            toolCalls: [
              toolCall("c1", "run_command", { command: "false", args: ["-a"] }),
              toolCall("c2", "run_command", { command: "false", args: ["-b"] }),
              toolCall("c3", "run_command", { command: "false", args: ["-c"] }),
            ],
          };
          return;
        }
        yield { content: "Done." };
      },
    };
    const events: TanyaEvent[] = [];

    await runAgent({
      provider,
      prompt: "Try a few variants.",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 3,
    });

    const outputs = toolResultOutputs(events);
    expect(outputs).toHaveLength(3);
    // Every command actually ran (none were skipped) — all three fail (ok:false).
    const failures = events.filter((e) => e.type === "tool_result" && e.ok === false);
    expect(failures).toHaveLength(3);
    // Only the 3rd carries the strategy-change nudge.
    expect(outputs[0]).not.toMatch(/Stop retrying variants/);
    expect(outputs[1]).not.toMatch(/Stop retrying variants/);
    expect(outputs[2]).toMatch(/Stop retrying variants/);
    expect(outputs[2]).toMatch(/Third failure with effectively the same command/);

    // Exactly one status advisory (not one per repeated hit).
    const advisories = events.filter((event) => event.type === "status" && event.message.includes("Stop retrying variants"));
    expect(advisories).toHaveLength(1);
  });

  it("does not fingerprint two different failures under the same binary as duplicates", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-near-dup-distinct-"));
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        requests.push(input);
        if (requests.length === 1) {
          yield {
            toolCalls: [
              toolCall("c1", "run_command", { command: "sh", args: ["-c", "exit 1"] }),
              toolCall("c2", "run_command", { command: "sh", args: ["-c", "echo different message; exit 1"] }),
              toolCall("c3", "run_command", { command: "sh", args: ["-c", "exit 1"] }),
            ],
          };
          return;
        }
        yield { content: "Done." };
      },
    };
    const events: TanyaEvent[] = [];

    await runAgent({
      provider,
      prompt: "Run distinct failing commands.",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 3,
    });

    const outputs = toolResultOutputs(events);
    expect(outputs).toHaveLength(3);
    // c1 and c3 share a fingerprint (2 hits, below the 3-strike limit) — no nudge.
    expect(outputs.some((o) => o.includes("Stop retrying variants"))).toBe(false);
  });

  it("a file mutation between failures re-arms the near-duplicate counter", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-near-dup-rearm-"));
    const requests: ChatRequest[] = [];
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        requests.push(input);
        if (requests.length === 1) {
          yield {
            toolCalls: [
              toolCall("c1", "run_command", { command: "false", args: ["-a"] }),
              toolCall("c2", "run_command", { command: "false", args: ["-b"] }),
              toolCall("w1", "write_file", { path: "note.txt", content: "x\n" }),
              toolCall("c3", "run_command", { command: "false", args: ["-c"] }),
              toolCall("c4", "run_command", { command: "false", args: ["-d"] }),
            ],
          };
          return;
        }
        yield { content: "Done." };
      },
    };
    const events: TanyaEvent[] = [];

    await runAgent({
      provider,
      prompt: "Fail, mutate, fail again.",
      cwd,
      sink: async (event) => { events.push(event); },
      maxTurns: 3,
    });

    const outputs = toolResultOutputs(events);
    // 4 failures total, but the write_file in between resets the revision-scoped
    // counter, so neither pre- nor post-mutation pair reaches the 3-strike limit.
    expect(outputs.filter((o) => o.includes("Stop retrying variants"))).toHaveLength(0);
  });
});
