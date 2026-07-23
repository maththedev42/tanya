import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectVisibleArtifacts, MAX_TURNS, runAgenticUITest } from "../../../src/runtime/tier1/agenticUI";
import { makeFakeExec } from "../fakeExec";
import type { InteractDriver } from "../../../src/runtime/tier1/types";

// ── fake interact driver ───────────────────────────────────────────────────

function makeDriver(
  config: {
    canTap?: boolean;
    trees?: string[];
  } = {},
) {
  const { canTap = true, trees = ["Screen: 400x800\nButton \"Go\" center=(200,400) size=100x50"] } = config;
  const log: string[] = [];
  let treeIdx = 0;
  const driver: InteractDriver = {
    canTap,
    async describeUi() {
      log.push("describeUi");
      const tree = trees[Math.min(treeIdx, trees.length - 1)] ?? null;
      treeIdx++;
      return tree;
    },
    async screenshot(path: string) {
      log.push(`screenshot:${path}`);
      return true;
    },
    async tap(x: number, y: number) {
      log.push(`tap:${x},${y}`);
    },
    async typeText(text: string) {
      log.push(`type:${text}`);
    },
  };
  return { driver, log };
}

// ── mock fetch helper (OpenAI chat-completions shape) ──────────────────────

const UI_MODEL = { baseUrl: "https://api.deepseek.com", apiKey: "sk-test", model: "deepseek-test" };

type FakeToolCall = { name: string; arguments: Record<string, unknown> };

function mockFetchSequence(turns: Array<FakeToolCall[] | string>): {
  requests: Array<Record<string, unknown>>;
} {
  let call = 0;
  const requests: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body) as Record<string, unknown>);
    const turn = turns[call] ?? turns[turns.length - 1];
    call++;
    const message =
      typeof turn === "string"
        ? { role: "assistant", content: turn }
        : {
            role: "assistant",
            content: null,
            tool_calls: (turn ?? []).map((t, i) => ({
              id: `call-${call}-${i}`,
              type: "function",
              function: { name: t.name, arguments: JSON.stringify(t.arguments) },
            })),
          };
    return {
      ok: true,
      json: async () => ({ choices: [{ message }] }),
      text: async () => "",
    };
  });
  return { requests };
}

const PASS_VERDICT: FakeToolCall = {
  name: "submit_verdict",
  arguments: {
    passed: true,
    appDescription: "A calculator app",
    summary: "All buttons present and functional",
    checks: [{ action: "viewed tree", expected: "buttons labeled", actual: "buttons labeled", passed: true }],
    issues: [],
  },
};

const RUN_OPTS = {
  workspace: "/ws",
  evidenceDir: "/ev",
  uiModel: UI_MODEL,
  platform: "ios" as const,
  initialTree: 'Screen: 400x800\nButton "Go" center=(200,400) size=100x50',
  emit: () => {},
};

// ── tests ──────────────────────────────────────────────────────────────────

describe("runAgenticUITest", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("model calls submit_verdict immediately → returns that verdict and writes the report", async () => {
    const { requests } = mockFetchSequence([[PASS_VERDICT]]);
    const exec = makeFakeExec();
    const { driver } = makeDriver();
    const verdict = await runAgenticUITest({ exec, driver, ...RUN_OPTS });
    expect(verdict.passed).toBe(true);
    expect(verdict.appDescription).toBe("A calculator app");
    expect(verdict.issues).toHaveLength(0);
    // The initial tree travels in the first user message.
    const first = requests[0] as { messages: Array<{ role: string; content: string }> };
    expect(first.messages.find((m) => m.role === "user")?.content).toContain('Button "Go"');
    // The self-fix report is persisted on every path.
    expect(exec.written["/ev/ui-report.json"]).toContain('"passed": true');
    expect(exec.written["/ev/ui-report.md"]).toContain("Result: PASS");
  });

  it("tap executes, attaches a fresh tree to the tool result, and captures evidence frames", async () => {
    const { requests } = mockFetchSequence([
      [{ name: "tap", arguments: { x: 200, y: 400 } }],
      [
        {
          name: "submit_verdict",
          arguments: {
            passed: false,
            appDescription: "A notes app",
            summary: "Save button missing",
            checks: [{ action: "tapped New Note", expected: "Save button appears", actual: "no Save button", passed: false }],
            issues: ["Save button is not visible after creating a note"],
          },
        },
      ],
    ]);
    const exec = makeFakeExec();
    const { driver, log } = makeDriver({
      trees: ['Screen: 400x800\nButton "New Note" center=(200,400) size=100x50', "Screen: 400x800\nTextField center=(200,100) size=300x40"],
    });
    const verdict = await runAgenticUITest({ exec, driver, ...RUN_OPTS });
    expect(verdict.passed).toBe(false);
    expect(verdict.issues).toContain("Save button is not visible after creating a note");
    expect(log).toContain("tap:200,400");
    // initial evidence frame + post-tap evidence frame
    expect(log.filter((e) => e.startsWith("screenshot"))).toHaveLength(2);
    // The tap tool result carries the fresh tree back to the model.
    const turn2 = requests[1] as { messages: Array<{ role: string; content: string; tool_call_id?: string }> };
    const toolMsg = turn2.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("New UI tree");
    expect(exec.written["/ev/ui-report.md"]).toContain("Save button is not visible");
  });

  it("returns fail verdict when model never calls submit_verdict", async () => {
    mockFetchSequence(["I looked at the app and it seems fine."]);
    const exec = makeFakeExec();
    const { driver } = makeDriver();
    const verdict = await runAgenticUITest({ exec, driver, ...RUN_OPTS });
    expect(verdict.passed).toBe(false);
    expect(verdict.issues[0]).toMatch(/no submit_verdict/);
    expect(exec.written["/ev/ui-report.md"]).toContain("Result: FAIL");
  });

  it("feeds OCR on-screen text into the agent's view when an OCR reader is provided", async () => {
    const { requests } = mockFetchSequence([[{ name: "tap", arguments: { x: 200, y: 400 } }], [PASS_VERDICT]]);
    const exec = makeFakeExec();
    const { driver } = makeDriver();
    // The screen literally shows "\(n)" even though the tree labels are fine.
    const ocr = { read: async () => "0\n\\(n)\n\\(n)" };
    await runAgenticUITest({ exec, driver, ...RUN_OPTS, ocr });
    // The very first message carries the on-screen text, so the visual bug is
    // visible to the model from turn one.
    const firstUser = (requests[0] as { messages: Array<{ role: string; content: string }> }).messages.find(
      (m) => m.role === "user",
    );
    expect(firstUser?.content).toContain("ON-SCREEN TEXT");
    expect(firstUser?.content).toContain("\\(n)");
    // And every tool result keeps feeding it back after each interaction.
    const turn2 = requests[1] as { messages: Array<{ role: string; content: string }> };
    expect(turn2.messages.find((m) => m.role === "tool")?.content).toContain("ON-SCREEN TEXT");
  });

  it("narrates each action live via the tool's note (for the demo / debugging)", async () => {
    mockFetchSequence([
      [{ name: "tap", arguments: { x: 200, y: 400, note: "Tapping the 7 button to enter a digit." } }],
      [PASS_VERDICT],
    ]);
    const exec = makeFakeExec();
    const { driver } = makeDriver();
    const narration: string[] = [];
    await runAgenticUITest({ exec, driver, ...RUN_OPTS, emit: (m) => narration.push(m) });
    expect(narration.some((m) => m.includes("Tapping the 7 button to enter a digit."))).toBe(true);
  });

  it("read_ui returns a fresh tree", async () => {
    const { requests } = mockFetchSequence([[{ name: "read_ui", arguments: {} }], [PASS_VERDICT]]);
    const exec = makeFakeExec();
    const { driver } = makeDriver({ trees: ["TREE-A", "TREE-B"] });
    await runAgenticUITest({ exec, driver, ...RUN_OPTS });
    const turn2 = requests[1] as { messages: Array<{ role: string; content: string }> };
    expect(turn2.messages.find((m) => m.role === "tool")?.content).toBe("TREE-A");
  });

  it("canTap:false — driver tap is never called even if model tries", async () => {
    mockFetchSequence([[{ name: "tap", arguments: { x: 50, y: 50 } }, PASS_VERDICT]]);
    const exec = makeFakeExec();
    const { driver, log } = makeDriver({ canTap: false });
    const verdict = await runAgenticUITest({ exec, driver, ...RUN_OPTS });
    expect(verdict.passed).toBe(true);
    expect(log.filter((e) => e.startsWith("tap"))).toHaveLength(0);
  });

  it("malformed tool arguments degrade to empty args instead of crashing", async () => {
    let call = 0;
    vi.stubGlobal("fetch", async () => {
      call++;
      const message =
        call === 1
          ? {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "x1", type: "function", function: { name: "tap", arguments: "{not json" } }],
            }
          : {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "x2",
                  type: "function",
                  function: {
                    name: "submit_verdict",
                    arguments: JSON.stringify({ passed: true, appDescription: "a", summary: "s", checks: [], issues: [] }),
                  },
                },
              ],
            };
      return { ok: true, json: async () => ({ choices: [{ message }] }), text: async () => "" };
    });
    const exec = makeFakeExec();
    const { driver, log } = makeDriver();
    const verdict = await runAgenticUITest({ exec, driver, ...RUN_OPTS });
    expect(verdict.passed).toBe(true);
    expect(log).toContain("tap:0,0"); // empty args fall back to 0,0 — loop survives
  });

  // The final call narrows the toolset to submit_verdict only (no forced
  // tool_choice — thinking mode rejects that) so the model must end the session.
  function isFinalCall(body: Record<string, unknown>): boolean {
    return Array.isArray(body.tools) && body.tools.length === 1;
  }

  it("forces a final verdict (tool call) when the turn budget runs out", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      requests.push(body);
      const message = isFinalCall(body)
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "final",
                type: "function",
                function: {
                  name: "submit_verdict",
                  arguments: JSON.stringify({
                    passed: false,
                    appDescription: "an app",
                    summary: "buttons mislabeled",
                    checks: [],
                    issues: ["all digit buttons show a template artifact"],
                  }),
                },
              },
            ],
          }
        : {
            role: "assistant",
            content: null,
            tool_calls: [{ id: `t${requests.length}`, type: "function", function: { name: "tap", arguments: '{"x":1,"y":2}' } }],
          };
      return { ok: true, json: async () => ({ choices: [{ message }] }), text: async () => "" };
    });
    const exec = makeFakeExec();
    const { driver } = makeDriver();
    const verdict = await runAgenticUITest({ exec, driver, ...RUN_OPTS });
    expect(verdict.passed).toBe(false);
    expect(verdict.issues[0]).toMatch(/template artifact/);
    // All exploration turns + 1 forced-verdict call
    expect(requests).toHaveLength(MAX_TURNS + 1);
    // We never send a forced object tool_choice (thinking mode 400s on it).
    expect(requests.every((r) => r.tool_choice === undefined)).toBe(true);
    // The final request offered only submit_verdict.
    expect((requests[MAX_TURNS]?.tools as unknown[]).length).toBe(1);
    // The countdown nudge landed before the budget ran out.
    const allUserContents = requests.flatMap((r) => (r.messages as Array<{ role: string; content: string }>).filter((m) => m.role === "user").map((m) => m.content));
    expect(allUserContents.some((c) => c.includes("Only 4 interactions remain"))).toBe(true);
  });

  it("accepts a plain-JSON text verdict when the model answers in text (thinking mode)", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      const message = isFinalCall(body)
        ? {
            role: "assistant",
            // No tool_calls — the verdict comes back as fenced JSON text.
            content:
              'Here is my verdict:\n```json\n' +
              JSON.stringify({
                passed: false,
                appDescription: "a calculator",
                summary: "digit labels are broken",
                checks: [{ action: "tapped 7", expected: "shows 7", actual: "shows \\(n)", passed: false }],
                issues: ["every digit button renders the literal \\(n)"],
              }) +
              "\n```",
          }
        : {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "tap1", type: "function", function: { name: "tap", arguments: '{"x":1,"y":2}' } }],
          };
      return { ok: true, json: async () => ({ choices: [{ message }] }), text: async () => "" };
    });
    const exec = makeFakeExec();
    const { driver } = makeDriver();
    const verdict = await runAgenticUITest({ exec, driver, ...RUN_OPTS });
    expect(verdict.passed).toBe(false);
    expect(verdict.summary).toBe("digit labels are broken");
    expect(verdict.issues[0]).toMatch(/literal/);
    expect(exec.written["/ev/ui-report.md"]).toContain("Result: FAIL");
  });

  it("re-requests a complete verdict when the model submits a hollow one", async () => {
    let call = 0;
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      call++;
      // First (loop) call: a hollow submit_verdict — correct FAIL, no detail.
      // Second call (completion re-request, tools narrowed to 1): full verdict.
      const args = isFinalCall(body)
        ? {
            passed: false,
            appDescription: "a calculator",
            summary: "digit buttons are broken",
            checks: [],
            issues: ["every digit button shows the literal \\(n)"],
          }
        : { passed: false };
      const message = {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: `c${call}`, type: "function", function: { name: "submit_verdict", arguments: JSON.stringify(args) } },
        ],
      };
      return { ok: true, json: async () => ({ choices: [{ message }] }), text: async () => "" };
    });
    const exec = makeFakeExec();
    const { driver } = makeDriver();
    const verdict = await runAgenticUITest({ exec, driver, ...RUN_OPTS });
    expect(verdict.passed).toBe(false);
    expect(verdict.summary).toBe("digit buttons are broken");
    expect(verdict.issues[0]).toContain("\\(n)");
    // Exactly two calls: the hollow submit, then the completion re-request.
    expect(call).toBe(2);
    expect(exec.written["/ev/ui-report.md"]).toContain("every digit button shows the literal");
  });

  it("OCR safety net forces FAIL + a concrete blocker when the screen shows a template artifact, even if the model passes", async () => {
    mockFetchSequence([[PASS_VERDICT]]); // model wrongly reports all-good
    const exec = makeFakeExec();
    const { driver } = makeDriver();
    const ocr = { read: async () => "0\n\\(n)\n\\(n)\nAC" };
    const verdict = await runAgenticUITest({ exec, driver, ...RUN_OPTS, ocr });
    expect(verdict.passed).toBe(false);
    expect(verdict.issues.some((i) => i.includes("\\(n)"))).toBe(true);
    expect(exec.written["/ev/ui-report.md"]).toContain("Result: FAIL");
  });

  it("UI model API error throws and propagates", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid api key"}',
    }));
    const exec = makeFakeExec();
    const { driver } = makeDriver();
    await expect(runAgenticUITest({ exec, driver, ...RUN_OPTS })).rejects.toThrow("UI model API 401");
  });
});

describe("detectVisibleArtifacts", () => {
  it("flags template/interpolation artifacts and leaves normal UI text alone", () => {
    expect(detectVisibleArtifacts(["7\n\\(n)\nAC"])).toContain("\\(n)");
    expect(detectVisibleArtifacts(["Hello ${name}"])).toContain("${name}");
    expect(detectVisibleArtifacts(["{{ count }} items"])).toContain("{{ count }}");
    expect(detectVisibleArtifacts(["Score: %d"])).toContain("%d");
    expect(detectVisibleArtifacts(['Name: Optional("Jo")'])).toContain('Optional("Jo")');
    // Real calculator text — including a bare "%" button and percentages — is clean.
    expect(detectVisibleArtifacts(["7", "8", "9", "+", "=", "%", "AC", "0.5", "100%"])).toEqual([]);
  });

  it("dedupes repeated artifacts across frames", () => {
    expect(detectVisibleArtifacts(["\\(n)", "\\(n)\n\\(n)", "AC"])).toEqual(["\\(n)"]);
  });
});
