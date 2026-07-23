import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServeStdio, interactiveMaxTurnsOverride, autoContinueBudgetFromEnv, REPLAY_MAX_MESSAGE_CHARS } from "../serveStdio";
import { loadSession } from "../../sessions/storage";
import { WRAP_UP_TURNS } from "../../agent/progressBudget";
import type { TanyaEvent } from "../../events/types";
import type { ChatDelta, ChatProvider, ChatRequest, ToolCall } from "../../providers/types";

class JsonlOutput extends Writable {
  events: TanyaEvent[] = [];
  private buffer = "";
  private waiters: Array<() => void> = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      this.events.push(JSON.parse(line) as TanyaEvent);
    }
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
    callback();
  }

  async waitFor(predicate: (event: TanyaEvent) => boolean, timeoutMs = 2000): Promise<TanyaEvent> {
    const existing = this.events.find(predicate);
    if (existing) return existing;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      const event = this.events.find(predicate);
      if (event) return event;
    }
    throw new Error(`Timed out waiting for event. Seen: ${this.events.map((event) => event.type).join(", ")}`);
  }
}

class TextProvider implements ChatProvider {
  id = "test";
  model = "serve-test";

  async *streamChat(input: ChatRequest): AsyncGenerator<ChatDelta> {
    const prompt = input.messages.at(-1)?.content ?? "";
    yield { content: `hello ${prompt}`, usage: { promptTokens: 3, completionTokens: 2 } };
  }
}

// Records the system message of every request so tests can assert the
// session-pinned prompt stays byte-identical across turns (prefix-cache
// stability — see buildSessionSystemPrompt).
class SystemPromptCapturingProvider implements ChatProvider {
  id = "test";
  model = "serve-capture";
  systemPrompts: string[] = [];

  async *streamChat(input: ChatRequest): AsyncGenerator<ChatDelta> {
    const system = input.messages.find((message) => message.role === "system");
    this.systemPrompts.push(typeof system?.content === "string" ? system.content : "");
    yield { content: "done", usage: { promptTokens: 3, completionTokens: 2 } };
  }
}

function toolCall(id: string, name: string, input: unknown): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(input) },
  };
}

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "tanya-serve-stdio-"));
  mkdirSync(join(cwd, ".tanya"), { recursive: true });
  return cwd;
}

function startHarness(provider: ChatProvider, cwd = project(), resumeSessionId?: string, worktree = false) {
  const input = new PassThrough();
  const output = new JsonlOutput();
  const stderr = new PassThrough();
  const done = startServeStdio({
    provider,
    cwd,
    input,
    output,
    stderr,
    resumeSessionId,
    installProcessHandlers: false,
    worktree,
  });
  return { input, output, done, cwd };
}

function gitRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "tanya-serve-git-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
  execFileSync("git", ["config", "user.email", "t@tanya.local"], { cwd });
  execFileSync("git", ["config", "user.name", "T"], { cwd });
  writeFileSync(join(cwd, "README.md"), "hi\n");
  execFileSync("git", ["add", "README.md"], { cwd });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd });
  return cwd;
}

function send(input: PassThrough, message: unknown): void {
  input.write(`${JSON.stringify(message)}\n`);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("serve stdio protocol", () => {
  it("boots, runs a user message, and emits turn_complete", async () => {
    const { input, output, done } = startHarness(new TextProvider());

    await output.waitFor((event) => event.type === "session_ready");
    send(input, { type: "user_message", text: "say hi" });

    expect(await output.waitFor((event) => event.type === "message_delta")).toMatchObject({
      type: "message_delta",
      text: "hello say hi",
    });
    expect(await output.waitFor((event) => event.type === "turn_complete")).toMatchObject({
      type: "turn_complete",
      promptTokens: expect.any(Number),
      completionTokens: expect.any(Number),
      costUsd: expect.any(Number),
    });

    send(input, { type: "shutdown" });
    await done;
  });

  it("sends a byte-identical system prompt on every turn of a session", async () => {
    const provider = new SystemPromptCapturingProvider();
    const { input, output, done } = startHarness(provider);

    await output.waitFor((event) => event.type === "session_ready");
    send(input, { type: "user_message", text: "first task about splash icons" });
    await output.waitFor((event) => event.type === "turn_complete");
    // turn_complete is emitted inside the turn's finally, a beat before serve
    // clears its busy guard — give it a tick so the second message isn't bounced.
    await new Promise((resolve) => setTimeout(resolve, 50));
    send(input, { type: "user_message", text: "second, completely different: fix the api contract" });
    await output.waitFor(
      (event) => event.type === "turn_complete" && output.events.filter((seen) => seen.type === "turn_complete").length === 2,
    );

    expect(provider.systemPrompts.length).toBeGreaterThanOrEqual(2);
    expect(provider.systemPrompts[0]).toBeTruthy();
    for (const prompt of provider.systemPrompts) {
      expect(prompt).toBe(provider.systemPrompts[0]);
    }

    send(input, { type: "shutdown" });
    await done;
  });

  it("runs a task session in an isolated worktree and reports it in session_ready", async () => {
    const { input, output, done } = startHarness(new TextProvider(), gitRepo(), undefined, true);

    const ready = await output.waitFor((event) => event.type === "session_ready");
    expect((ready as { worktree?: string }).worktree).toBeTruthy();
    // The session's cwd is the worktree, not the main repo.
    expect((ready as { cwd: string }).cwd).toBe((ready as { worktree: string }).worktree);

    // A task command resolves against the worktree metadata.
    send(input, { type: "command", text: "/task-diff" });
    const status = await output.waitFor(
      (event) => event.type === "status" && typeof (event as { message?: string }).message === "string" &&
        (event as { message: string }).message.includes("tanya/task-"),
    );
    expect((status as { message: string }).message).toContain("Task branch: tanya/task-");

    send(input, { type: "shutdown" });
    await done;
  });

  it("refuses a task session outside a git repo before session_ready", async () => {
    const { input, output, done } = startHarness(new TextProvider(), project(), undefined, true);

    const error = await output.waitFor((event) => event.type === "error");
    expect((error as { code?: string }).code).toBe("worktree_requires_git");
    // No session_ready is emitted when the worktree can't be created.
    expect(output.events.some((event) => event.type === "session_ready")).toBe(false);

    send(input, { type: "shutdown" });
    await done;
  });

  it("round-trips permission requests through permission_answer", async () => {
    vi.stubEnv("TANYA_MODE", "ask");
    const cwd = project();
    writeFileSync(join(cwd, "note.txt"), "hello\n", "utf8");
    const provider: ChatProvider = {
      id: "test",
      model: "permission-model",
      async *streamChat(input) {
        const last = input.messages.at(-1);
        if (last?.role === "user") {
          yield { toolCalls: [toolCall("call-read", "read_file", { path: "note.txt" })] };
          return;
        }
        yield { content: "read done" };
      },
    };
    const { input, output, done } = startHarness(provider, cwd);
    await output.waitFor((event) => event.type === "session_ready");

    send(input, { type: "user_message", text: "read note" });
    const request = await output.waitFor((event) => event.type === "permission_request");
    expect(request).toMatchObject({ type: "permission_request", id: "call-read", tool: "read_file" });
    send(input, { type: "permission_answer", id: "call-read", decision: "allow" });

    expect(await output.waitFor((event) => event.type === "permission_decision")).toMatchObject({
      type: "permission_decision",
      id: "call-read",
      decision: "allow",
      source: "user",
    });
    expect(await output.waitFor((event) => event.type === "turn_complete")).toMatchObject({ type: "turn_complete" });

    send(input, { type: "shutdown" });
    await done;
  });

  it("interrupts an active shell turn and rejects concurrent user messages as busy", async () => {
    vi.stubEnv("TANYA_MODE", "bypass");
    const provider: ChatProvider = {
      id: "test",
      model: "interrupt-model",
      async *streamChat(input) {
        const last = input.messages.at(-1);
        if (last?.role === "user") {
          yield { toolCalls: [toolCall("call-sleep", "run_shell", { script: "sleep 5", timeoutMs: 10_000 })] };
          return;
        }
        yield { content: "after shell" };
      },
    };
    const { input, output, done } = startHarness(provider);
    await output.waitFor((event) => event.type === "session_ready");

    send(input, { type: "user_message", text: "sleep" });
    await output.waitFor((event) => event.type === "tool_call");
    send(input, { type: "user_message", text: "second" });
    expect(await output.waitFor((event) => event.type === "error" && event.code === "busy")).toMatchObject({
      type: "error",
      code: "busy",
    });

    send(input, { type: "interrupt" });
    expect(await output.waitFor((event) => event.type === "tool_cancel_requested")).toMatchObject({
      type: "tool_cancel_requested",
      toolCallId: "call-sleep",
    });
    expect(await output.waitFor((event) => event.type === "turn_complete", 5000)).toMatchObject({ type: "turn_complete" });

    send(input, { type: "shutdown" });
    await done;
  });

  it("materializes on EOF and replays a resumed session", async () => {
    const first = startHarness(new TextProvider());
    const ready = await first.output.waitFor((event) => event.type === "session_ready");
    if (ready.type !== "session_ready") throw new Error("missing ready");
    send(first.input, { type: "user_message", text: "persist me" });
    await first.output.waitFor((event) => event.type === "turn_complete");
    first.input.end();
    await first.done;

    const loaded = loadSession(ready.sessionId, { cwd: first.cwd }).session;
    expect(loaded.turns.map((turn) => turn.content)).toContain("persist me");

    const second = startHarness(new TextProvider(), first.cwd, ready.sessionId);
    const replay = await second.output.waitFor((event) => event.type === "session_replay");
    expect(replay).toMatchObject({
      type: "session_replay",
      messages: expect.arrayContaining([expect.objectContaining({ role: "user", content: "persist me" })]),
      // Persisted totals ride along so the client footer seeds instead of
      // resetting to zero on resume.
      stats: expect.objectContaining({
        promptTokens: expect.any(Number),
        completionTokens: expect.any(Number),
        costUsd: expect.any(Number),
        elapsedMs: expect.any(Number),
        turnCount: expect.any(Number),
      }),
    });
    await second.output.waitFor((event) => event.type === "session_ready");
    send(second.input, { type: "shutdown" });
    await second.done;
  });

  it("truncates pathological messages in the replay so the single JSONL line stays bounded", async () => {
    const first = startHarness(new TextProvider());
    const ready = await first.output.waitFor((event) => event.type === "session_ready");
    if (ready.type !== "session_ready") throw new Error("missing ready");
    send(first.input, { type: "user_message", text: `${"x".repeat(REPLAY_MAX_MESSAGE_CHARS + 5_000)}` });
    await first.output.waitFor((event) => event.type === "turn_complete");
    first.input.end();
    await first.done;

    const second = startHarness(new TextProvider(), first.cwd, ready.sessionId);
    const replay = await second.output.waitFor((event) => event.type === "session_replay");
    const messages = (replay as { messages: Array<{ role: string; content: string }> }).messages;
    const user = messages.find((message) => message.role === "user");
    expect(user).toBeDefined();
    expect(user!.content.length).toBeLessThan(REPLAY_MAX_MESSAGE_CHARS + 100);
    expect(user!.content.endsWith("… [truncated for replay]")).toBe(true);
    await second.output.waitFor((event) => event.type === "session_ready");
    send(second.input, { type: "shutdown" });
    await second.done;
  });

  it("auto-continues after a stall stop instead of waiting for the user", async () => {
    vi.stubEnv("TANYA_MODE", "bypass");
    // Soft budget of 1 turn: two failing tool turns trip the no-progress stall
    // stop. The runner then grants its fixed wrap-up window (beta.32) — this
    // provider keeps failing straight through it, so the stall stop truly
    // fires — and THEN serve must say "continue" itself and let the run finish.
    vi.stubEnv("TANYA_MAX_TURNS", "1");
    const failThrough = 2 + WRAP_UP_TURNS;
    let requests = 0;
    const provider: ChatProvider = {
      id: "test",
      model: "stall-model",
      async *streamChat() {
        requests += 1;
        if (requests <= failThrough) {
          yield { toolCalls: [toolCall(`call-${requests}`, "definitely_not_a_tool", {})] };
          return;
        }
        yield { content: "recovered and finished" };
      },
    };
    const { input, output, done } = startHarness(provider);
    await output.waitFor((event) => event.type === "session_ready");

    send(input, { type: "user_message", text: "do the thing" });

    await output.waitFor(
      (event) => event.type === "status" && /auto-continuing/i.test((event as { message?: string }).message ?? ""),
      15000,
    );
    // Two completed turns from ONE user message: the stalled one and the resume.
    await output.waitFor(() => output.events.filter((event) => event.type === "turn_complete").length >= 2, 15000);
    expect(requests).toBeGreaterThan(failThrough);

    send(input, { type: "shutdown" });
    await done;
  }, 30_000);

  it("routes slash commands and emits command output as status events", async () => {
    const { input, output, done } = startHarness(new TextProvider());
    await output.waitFor((event) => event.type === "session_ready");

    send(input, { type: "command", text: "/clear" });

    expect(await output.waitFor((event) => event.type === "command_invoked")).toMatchObject({
      type: "command_invoked",
      name: "clear",
      args: [],
    });
    expect(await output.waitFor((event) => event.type === "status" && event.message.includes("Conversation history cleared"))).toMatchObject({
      type: "status",
    });

    send(input, { type: "shutdown" });
    await done;
  });

  it("lists available commands on request", async () => {
    const { input, output, done } = startHarness(new TextProvider());
    await output.waitFor((event) => event.type === "session_ready");

    send(input, { type: "list_commands" });

    const event = await output.waitFor((event) => event.type === "commands");
    if (event.type !== "commands") throw new Error("expected commands event");
    expect(Array.isArray(event.commands)).toBe(true);
    const clear = event.commands.find((command) => command.name === "clear");
    expect(clear).toMatchObject({ name: "clear", category: "built-in" });
    expect(typeof clear?.description).toBe("string");

    send(input, { type: "shutdown" });
    await done;
  });

  it("rejects stale permission answers without crashing", async () => {
    const { input, output, done } = startHarness(new TextProvider());
    await output.waitFor((event) => event.type === "session_ready");

    send(input, { type: "permission_answer", id: "missing", decision: "allow" });

    expect(await output.waitFor((event) => event.type === "error" && event.code === "unknown_permission")).toMatchObject({
      type: "error",
      code: "unknown_permission",
    });

    send(input, { type: "shutdown" });
    await done;
  });

  it("emits an error for malformed JSON and keeps serving", async () => {
    const { input, output, done } = startHarness(new TextProvider());
    await output.waitFor((event) => event.type === "session_ready");

    input.write("{not json\n");
    expect(await output.waitFor((event) => event.type === "error" && event.code === "malformed_json")).toMatchObject({
      type: "error",
      code: "malformed_json",
    });

    send(input, { type: "user_message", text: "still alive" });
    expect(await output.waitFor((event) => event.type === "message_delta")).toMatchObject({
      type: "message_delta",
      text: "hello still alive",
    });
    send(input, { type: "shutdown" });
    await done;
  });
});

describe("autoContinueBudgetFromEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 2 automatic continues", () => {
    expect(autoContinueBudgetFromEnv()).toBe(2);
  });

  it("honours numeric overrides and off switches", () => {
    vi.stubEnv("TANYA_AUTO_CONTINUE", "5");
    expect(autoContinueBudgetFromEnv()).toBe(5);
    vi.stubEnv("TANYA_AUTO_CONTINUE", "0");
    expect(autoContinueBudgetFromEnv()).toBe(0);
    vi.stubEnv("TANYA_AUTO_CONTINUE", "off");
    expect(autoContinueBudgetFromEnv()).toBe(0);
    vi.stubEnv("TANYA_AUTO_CONTINUE", "garbage");
    expect(autoContinueBudgetFromEnv()).toBe(2);
  });
});

describe("interactiveMaxTurnsOverride", () => {
  afterEach(() => {
    delete process.env.TANYA_MAX_TURNS;
  });

  it("is undefined when unset or invalid", () => {
    delete process.env.TANYA_MAX_TURNS;
    expect(interactiveMaxTurnsOverride()).toBeUndefined();
    process.env.TANYA_MAX_TURNS = "";
    expect(interactiveMaxTurnsOverride()).toBeUndefined();
    process.env.TANYA_MAX_TURNS = "not-a-number";
    expect(interactiveMaxTurnsOverride()).toBeUndefined();
    process.env.TANYA_MAX_TURNS = "-5";
    expect(interactiveMaxTurnsOverride()).toBeUndefined();
  });

  it("parses a positive integer budget", () => {
    process.env.TANYA_MAX_TURNS = "120";
    expect(interactiveMaxTurnsOverride()).toBe(120);
    process.env.TANYA_MAX_TURNS = "80.9";
    expect(interactiveMaxTurnsOverride()).toBe(80);
  });
});
