import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent/runner";
import { DRIFT_FIRST_NUDGE_TURN, DRIFT_WRAP_UP_TURN, WRAP_UP_TURNS } from "../src/agent/progressBudget";
import type { ChatProvider, ChatRequest } from "../src/providers/types";

// The 2026-07-21 failure class: a coding run reads a different file every
// turn (each read counts as PROGRESS, so no stall stop ever fires), writes
// nothing, and drifts through the whole budget. The drift guard must
// confront it early instead.

function workspaceWithFiles(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), "tanya-drift-"));
  for (let i = 0; i < count; i += 1) {
    writeFileSync(join(dir, `f${i}.txt`), `file ${i}\n`);
  }
  return dir;
}

function readingProvider(dir: string): ChatProvider & { requests: ChatRequest[] } {
  const provider: ChatProvider & { requests: ChatRequest[] } = {
    id: "test",
    model: "drift-model",
    requests: [],
    async *streamChat(input: ChatRequest) {
      provider.requests.push({ ...input, messages: [...input.messages] });
      const n = provider.requests.length;
      yield {
        content: `researching ${n}`,
        usage: { promptTokens: 50, completionTokens: 1 },
        toolCalls: [{ id: `read-${n}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: join(dir, `f${n}.txt`) }) } }],
      };
    },
  };
  return provider;
}

const driftText = (requests: ChatRequest[]) =>
  requests.flatMap((request) => request.messages)
    .filter((message) => message.role === "user" && typeof message.content === "string")
    .map((message) => message.content as string)
    .filter((content) => content.includes("READ-ONLY DRIFT"));

describe("read-only drift guard (runner integration)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a coding run that only reads gets the implement-now nudge at turn 8", async () => {
    const dir = workspaceWithFiles(20);
    const provider = readingProvider(dir);

    await runAgent({
      provider,
      prompt: "Add the four missing GA4 funnel events.",
      cwd: dir,
      maxTurns: DRIFT_FIRST_NUDGE_TURN + 3,
      sink: async () => {},
      runContext: { task: { kind: "coding" } },
    });

    const nudges = driftText(provider.requests);
    expect(nudges.length).toBeGreaterThanOrEqual(1);
    expect(nudges[0]).toContain("FIRST real edit");
  });

  it("still zero edits at turn 24 → drift limit directive and the run is closed within the wrap-up window", async () => {
    const dir = workspaceWithFiles(40);
    const provider = readingProvider(dir);

    await runAgent({
      provider,
      prompt: "Add the four missing GA4 funnel events.",
      cwd: dir,
      maxTurns: DRIFT_WRAP_UP_TURN + 12,
      sink: async () => {},
      runContext: { task: { kind: "coding" } },
    });

    expect(driftText(provider.requests).some((content) => content.includes("READ-ONLY DRIFT LIMIT"))).toBe(true);
    // Wrap-up deadline is hard: the run must end within the window, well
    // before its turn cap.
    expect(provider.requests.length).toBeLessThanOrEqual(DRIFT_WRAP_UP_TURN + WRAP_UP_TURNS + 1);
  });

  it("a run whose first turn writes a file is never drift-nudged", async () => {
    // Bypass mode so the mock write_file actually executes — a denied write
    // is not a mutation, and the guard would (correctly) still fire.
    vi.stubEnv("TANYA_MODE", "bypass");
    const dir = workspaceWithFiles(20);
    const provider: ChatProvider & { requests: ChatRequest[] } = {
      id: "test",
      model: "drift-model",
      requests: [],
      async *streamChat(input: ChatRequest) {
        provider.requests.push({ ...input, messages: [...input.messages] });
        const n = provider.requests.length;
        yield n === 1
          ? {
            content: "writing",
            usage: { promptTokens: 50, completionTokens: 1 },
            toolCalls: [{ id: "w-1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "out.txt", content: "done\n" }) } }],
          }
          : {
            content: `verifying ${n}`,
            usage: { promptTokens: 50, completionTokens: 1 },
            toolCalls: [{ id: `read-${n}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: join(dir, `f${n}.txt`) }) } }],
          };
      },
    };

    await runAgent({
      provider,
      prompt: "Add the four missing GA4 funnel events.",
      cwd: dir,
      maxTurns: DRIFT_FIRST_NUDGE_TURN + 3,
      sink: async () => {},
      runContext: { task: { kind: "coding" } },
    });

    expect(driftText(provider.requests)).toHaveLength(0);
  });

  it("a plain chat run (no coding context) is never drift-nudged", async () => {
    const dir = workspaceWithFiles(20);
    const provider = readingProvider(dir);

    await runAgent({
      provider,
      prompt: "how does the event system work?",
      cwd: dir,
      maxTurns: DRIFT_FIRST_NUDGE_TURN + 3,
      interactive: true,
      sink: async () => {},
    });

    expect(driftText(provider.requests)).toHaveLength(0);
  });
});
