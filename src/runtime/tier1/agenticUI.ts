import { join } from "node:path";
import type { RuntimeExec } from "../types";
import type { ScreenOcr } from "./ocr";
import { makeSystemPrompt } from "./prompt";
import type { InteractDriver, UICheck, UIVerdict, UiModelConfig } from "./types";

// Budget for a THOROUGH pass: enough turns to exercise every function of a
// typical screen (a calculator has ~10 distinct behaviors), not just a few
// exploratory taps. The forced-verdict + completeness + OCR safety nets still
// guarantee termination and a real report.
export const MAX_TURNS = 24;
// Generous so thinking-mode models (DeepSeek V4 defaults to it) have room for
// reasoning AND the final verdict JSON in the same completion.
const MAX_TOKENS = 8192;

// OpenAI-compatible chat-completions protocol (the format DeepSeek and the
// rest of the ecosystem speak). The agent reads the UI tree as plain text, so
// Tanya's own DeepSeek config drives the whole loop — no vision model.
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type AssistantMessage = { role: "assistant"; content: string | null; tool_calls?: ToolCall[] };
type Message =
  | { role: "system" | "user"; content: string }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

// Every interaction tool takes a `note`: the model's plain-language narration of
// what it is doing right now, surfaced live — great for a demo, and for watching
// a run debug itself in real time.
const NOTE_PROP = {
  type: "string",
  description:
    'One short first-person sentence saying what you are doing and what you observe right now, in plain language — it is shown live to a person watching you test. E.g. "Tapping the 7 button to enter a digit." or "The digit buttons show \\(n) instead of numbers."',
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_ui",
      description: "Return a fresh UI element tree of the current screen.",
      parameters: { type: "object", properties: { note: NOTE_PROP } },
    },
  },
  {
    type: "function",
    function: {
      name: "tap",
      description:
        "Tap at the given coordinates (use element center coordinates from the UI tree). The result includes the new UI tree.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number", description: "X center coordinate from the UI tree" },
          y: { type: "number", description: "Y center coordinate from the UI tree" },
          note: NOTE_PROP,
        },
        required: ["x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description: "Type text into the currently focused input field. The result includes the new UI tree.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" }, note: NOTE_PROP },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_verdict",
      description: "Submit the final test verdict. You MUST call this to end the session.",
      parameters: {
        type: "object",
        properties: {
          passed: { type: "boolean" },
          appDescription: { type: "string", description: "One sentence: what this app does" },
          summary: { type: "string", description: "One sentence: overall result" },
          checks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                action: { type: "string" },
                expected: { type: "string" },
                actual: { type: "string" },
                passed: { type: "boolean" },
              },
              required: ["action", "expected", "actual", "passed"],
            },
          },
          issues: { type: "array", items: { type: "string" } },
        },
        required: ["passed", "appDescription", "summary", "checks", "issues"],
      },
    },
  },
];

async function callModel(
  config: UiModelConfig,
  messages: Message[],
  options: { tools?: typeof TOOLS } = {},
): Promise<AssistantMessage> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    // No `tool_choice`: DeepSeek thinking mode (the V4 default) rejects a forced
    // object tool_choice with a 400. We steer the final verdict by narrowing the
    // toolset instead, and accept a JSON text reply as a fallback.
    body: JSON.stringify({
      model: config.model,
      max_tokens: MAX_TOKENS,
      messages,
      tools: options.tools ?? TOOLS,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`UI model API ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as { choices?: Array<{ message?: AssistantMessage }> };
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("UI model API returned no choices");
  return message;
}

// The submit_verdict tool on its own — used for the final forced call so the
// model can only end the session (or answer in text), never keep tapping.
const VERDICT_ONLY_TOOLS = TOOLS.filter((t) => t.function.name === "submit_verdict");

// Thinking-mode models often wrap their answer in prose or a ```json fence
// even when asked for raw JSON. Pull the verdict object out of either shape.
function extractVerdictJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
    } catch {
      // try the next candidate shape
    }
  }
  return null;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toVerdict(args: Record<string, unknown>): UIVerdict {
  return {
    passed: Boolean(args.passed),
    appDescription: String(args.appDescription ?? ""),
    summary: String(args.summary ?? ""),
    checks: Array.isArray(args.checks) ? (args.checks as UICheck[]) : [],
    issues: Array.isArray(args.issues) ? (args.issues as string[]) : [],
  };
}

// A verdict is only useful if it actually says something. Thinking-mode models
// sometimes call submit_verdict with truncated/near-empty arguments (correct
// pass/fail, but no summary, checks, or issues) — that is not a report a human
// or the fix loop can act on, so we treat it like a missing verdict.
function isComplete(verdict: UIVerdict | null): verdict is UIVerdict {
  return (
    !!verdict &&
    (verdict.summary.trim().length > 0 || verdict.issues.length > 0 || verdict.checks.length > 0)
  );
}

// Deterministic safety net. Regardless of what the (flaky, thinking-mode) model
// reports, raw template artifacts left visible on screen are unambiguous
// rendering bugs. These patterns are never legitimate on-screen text, so we can
// force a FAIL and name them — a hollow or over-confident model verdict can
// never hide a "\(n)"-style bug, and the fix loop always gets a concrete blocker
// pointing at the real defect (not a speculative one).
const ARTIFACT_PATTERNS: RegExp[] = [
  /\\\([^)\n]{0,40}\)/g, // Swift string interpolation: \(n)
  /\$\{[^}\n]{0,40}\}/g, // JS template literal: ${value}
  /\{\{[^}\n]{0,40}\}\}/g, // mustache / handlebars / Vue: {{ name }}
  /%(?:\d+\$)?[sd@]\b/g, // printf / format specifier: %s %d %@ %1$@
  /Optional\([^)\n]{0,40}\)/g, // Swift Optional debug leak: Optional("x")
];

export function detectVisibleArtifacts(screenTexts: string[]): string[] {
  const found = new Set<string>();
  for (const text of screenTexts) {
    for (const pattern of ARTIFACT_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const token = match[0].trim();
        if (token) found.add(token);
      }
    }
  }
  return [...found];
}

function augmentVerdictWithArtifacts(verdict: UIVerdict | null, artifacts: string[]): UIVerdict {
  const base: UIVerdict = verdict ?? { passed: false, appDescription: "", summary: "", checks: [], issues: [] };
  const existing = base.issues.join("\n");
  const added = artifacts
    .filter((artifact) => !existing.includes(artifact))
    .map(
      (artifact) =>
        `On-screen text shows the unrendered template artifact "${artifact}" instead of a real value — a visual rendering bug confirmed by OCR.`,
    );
  return {
    passed: false,
    appDescription: base.appDescription,
    summary:
      base.summary ||
      `The UI displays unrendered template artifacts (${artifacts.join(", ")}) instead of real values.`,
    checks: base.checks,
    issues: [...base.issues, ...added],
  };
}

// Renders the verdict as the report Tanya reads back during a fix loop —
// every failed check pairs what was tried with what actually happened.
export function renderUiReport(verdict: UIVerdict): string {
  const lines: string[] = [];
  lines.push(`# Tier-1 UI test report`);
  lines.push("");
  lines.push(`App: ${verdict.appDescription || "unknown"}`);
  lines.push(`Result: ${verdict.passed ? "PASS" : "FAIL"} — ${verdict.summary}`);
  if (verdict.checks.length > 0) {
    lines.push("");
    lines.push("## Checks");
    for (const check of verdict.checks) {
      const tag = check.passed ? "ok" : "FAIL";
      lines.push(`- [${tag}] ${check.action}`);
      lines.push(`  - expected: ${check.expected}`);
      lines.push(`  - actual: ${check.actual}`);
    }
  }
  if (verdict.issues.length > 0) {
    lines.push("");
    lines.push("## Issues to fix");
    for (const issue of verdict.issues) lines.push(`- ${issue}`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function runAgenticUITest(options: {
  exec: RuntimeExec;
  workspace: string;
  driver: InteractDriver;
  evidenceDir: string;
  uiModel: UiModelConfig;
  platform: "ios" | "android";
  // The tree the adapter hook already fetched to decide Tier-1 can run.
  initialTree: string;
  // On-device OCR of each frame so the agent perceives what is literally drawn,
  // not just the accessibility tree. Optional: omitted in tests / when the host
  // has no Swift toolchain, in which case the agent runs tree-only as before.
  ocr?: ScreenOcr | undefined;
  emit: (msg: string) => void;
}): Promise<UIVerdict> {
  const { exec, driver, evidenceDir, uiModel, platform, initialTree, ocr, emit } = options;

  let stepIdx = 0;
  // A frame per interaction: evidence for the user AND the input to OCR so the
  // agent can read the real on-screen text. Returns the path written (or null).
  const captureFrame = async (): Promise<string | null> => {
    const path = join(evidenceDir, `tier1-step-${stepIdx++}.png`);
    const ok = await driver.screenshot(path).catch(() => false);
    return ok ? path : null;
  };

  const ocrFrame = async (framePath: string | null): Promise<string | null> => {
    if (!framePath || !ocr) return null;
    return ocr.read(framePath).catch(() => null);
  };

  // Append the OCR'd on-screen text (when available) to a tree-based view so the
  // model can spot label-vs-visible mismatches — the whole point of OCR here.
  const withScreenText = (body: string, screenText: string | null): string => {
    if (!screenText) return body;
    return `${body}\n\nON-SCREEN TEXT — what is literally drawn on the display, recognized via OCR:\n${screenText}\n\nIf this visible text differs from an element's accessibility label above (for example the label is "7" but the screen shows "\\(n)"), the user sees the OCR text — record that mismatch as a bug.`;
  };

  const finish = async (verdict: UIVerdict): Promise<UIVerdict> => {
    await exec.writeFile(join(evidenceDir, "ui-report.json"), `${JSON.stringify(verdict, null, 2)}\n`).catch(() => undefined);
    await exec.writeFile(join(evidenceDir, "ui-report.md"), renderUiReport(verdict)).catch(() => undefined);
    return verdict;
  };

  const freshTree = async (): Promise<string> =>
    (await driver.describeUi()) ?? "(UI tree unavailable for this read)";

  // Every frame's OCR text, accumulated for the deterministic artifact safety net.
  const seenScreenText: string[] = [];
  const initialFrame = await captureFrame();
  const initialScreenText = await ocrFrame(initialFrame);
  if (initialScreenText) seenScreenText.push(initialScreenText);

  const messages: Message[] = [
    { role: "system", content: makeSystemPrompt(platform) },
    {
      role: "user",
      content: `${withScreenText(`Current UI tree:\n\n${initialTree}`, initialScreenText)}\n\nBegin testing.`,
    },
  ];

  let verdict: UIVerdict | null = null;

  for (let turn = 0; turn < MAX_TURNS && !verdict; turn++) {
    // Exploration-happy models keep tapping forever — warn them while there
    // is still room to wrap up cleanly.
    const remaining = MAX_TURNS - turn;
    if (remaining === 4) {
      messages.push({
        role: "user",
        content: "Only 4 interactions remain. Stop exploring, finish your current check, and call submit_verdict with everything you observed so far.",
      });
    }
    emit(`UI agent turn ${turn + 1}/${MAX_TURNS}`);
    const assistant = await callModel(uiModel, messages);
    messages.push(assistant);

    const toolCalls = assistant.tool_calls ?? [];
    if (toolCalls.length === 0) {
      emit("UI agent returned no tool calls — ending loop");
      break;
    }

    for (const call of toolCalls) {
      const name = call.function.name;
      const args = parseArguments(call.function.arguments);
      // Live narration: the model says, in plain language, what it is doing —
      // surfaced as it happens so a viewer (or someone debugging the run) can
      // follow along instead of reading raw coordinates.
      const note = typeof args.note === "string" ? args.note.trim() : "";
      if (note) emit(`🗣  ${note}`);
      let result = "";

      if (name === "submit_verdict") {
        verdict = toVerdict(args);
        emit(`UI verdict: ${verdict.passed ? "PASS" : "FAIL"} — ${verdict.summary}`);
        result = "Verdict recorded.";
      } else if (name === "read_ui") {
        const frame = await captureFrame();
        const tree = await freshTree();
        const screenText = await ocrFrame(frame);
        if (screenText) seenScreenText.push(screenText);
        result = withScreenText(tree, screenText);
      } else if (name === "tap") {
        if (driver.canTap) {
          const x = Number(args.x ?? 0);
          const y = Number(args.y ?? 0);
          emit(`UI tap (${x}, ${y})`);
          await driver.tap(x, y);
          await exec.sleep(800);
          const frame = await captureFrame();
          const tree = await freshTree();
          const screenText = await ocrFrame(frame);
          if (screenText) seenScreenText.push(screenText);
          result = withScreenText(`Tapped (${x}, ${y}). New UI tree:\n\n${tree}`, screenText);
        } else {
          result = "tap not available on this host";
        }
      } else if (name === "type_text") {
        if (driver.canTap) {
          const text = String(args.text ?? "");
          emit(`UI type: "${text}"`);
          await driver.typeText(text);
          await exec.sleep(500);
          const frame = await captureFrame();
          const tree = await freshTree();
          const screenText = await ocrFrame(frame);
          if (screenText) seenScreenText.push(screenText);
          result = withScreenText(`Typed: "${text}". New UI tree:\n\n${tree}`, screenText);
        } else {
          result = "type not available on this host";
        }
      } else {
        result = `unknown tool: ${name}`;
      }

      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  // No verdict, or a hollow one (truncated thinking-mode args): ask once more
  // for a COMPLETE, concise verdict. We offer ONLY submit_verdict (so it can't
  // keep tapping) and accept either that tool call or a plain-JSON reply — both
  // work in thinking mode, which rejects a forced object tool_choice outright.
  if (!isComplete(verdict)) {
    emit(verdict ? "verdict was empty — requesting a complete one" : "turn budget exhausted — requesting a final verdict");
    try {
      const final = await callModel(
        uiModel,
        [
          ...messages,
          {
            role: "user",
            content:
              'Stop testing now and report. Be concise — do not overthink. Give your final verdict by calling submit_verdict (or, if you cannot call a tool, reply with ONLY this JSON and nothing else): {"passed":boolean,"appDescription":"one sentence","summary":"one sentence","checks":[{"action":string,"expected":string,"actual":string,"passed":boolean}],"issues":["each concrete problem in one short sentence — include any element whose on-screen text was a template artifact or did not match its accessibility label"]}.',
          },
        ],
        { tools: VERDICT_ONLY_TOOLS },
      );
      const call = (final.tool_calls ?? []).find((c) => c.function.name === "submit_verdict");
      let candidate: UIVerdict | null = null;
      if (call) {
        candidate = toVerdict(parseArguments(call.function.arguments));
      } else if (typeof final.content === "string") {
        const parsed = extractVerdictJson(final.content);
        if (parsed) candidate = toVerdict(parsed);
      }
      // Keep the new verdict when it is complete, or when we had nothing at all.
      if (candidate && (isComplete(candidate) || !verdict)) {
        verdict = candidate;
        emit(`UI verdict (final): ${verdict.passed ? "PASS" : "FAIL"} — ${verdict.summary || "(no summary)"}`);
      } else if (!candidate) {
        emit("final verdict reply could not be parsed");
      }
    } catch (err) {
      emit(`final verdict request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Deterministic OCR safety net, applied to whatever the model concluded:
  // visible template artifacts are unambiguous bugs, so force a FAIL that names
  // them. A hollow/over-confident verdict can no longer hide a "\(n)"-style bug,
  // and the fix loop gets a concrete blocker instead of wandering.
  const artifacts = detectVisibleArtifacts(seenScreenText);
  if (artifacts.length > 0) {
    emit(`OCR safety net caught on-screen template artifact(s): ${artifacts.join(", ")}`);
    verdict = augmentVerdictWithArtifacts(verdict, artifacts);
  }

  return finish(
    verdict ?? {
      passed: false,
      appDescription: "unknown",
      summary: `UI agent did not submit a verdict within ${MAX_TURNS} turns`,
      checks: [],
      issues: [`no submit_verdict after ${MAX_TURNS} turns`],
    },
  );
}
