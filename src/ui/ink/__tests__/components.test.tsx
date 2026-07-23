import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { Static } from "ink";
import { ActivityPanel } from "../ActivityPanel";
import { Footer } from "../Footer";
import { History, splitHistoryMessages } from "../History";
import { Input } from "../Input";
import { Spinner } from "../Spinner";
import { createInitialInkState, inkReducer } from "../state";
import { App } from "../App";
import { SessionPicker } from "../SessionPicker";
import type { ChatProvider } from "../../../providers/types";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Ink TUI components", () => {
  it("renders user and assistant messages with timestamps and elapsed headings", () => {
    const timestampMs = new Date(2026, 4, 17, 12, 34, 56).getTime();
    const { lastFrame } = render(
      <History
        pendingTurn={null}
        liveAssistantId={null}
        messages={[
          { id: "u1", role: "user", content: "hello", timestampMs },
          { id: "a1", role: "assistant", content: "hi back", timestampMs: timestampMs + 3200, elapsedMs: 3200 },
        ]}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("[12:34:56] You:");
    expect(frame).toContain("hello");
    expect(frame).toContain("Tanya · 3.2s:");
    expect(frame).toContain("hi back");
  });

  it("keeps finalized messages separate from the live assistant during a pending turn", () => {
    const timestampMs = new Date(2026, 4, 17, 12, 34, 56).getTime();
    const messages = [
      { id: "u1", role: "user" as const, content: "hello", timestampMs },
      { id: "a1", role: "assistant" as const, content: "streaming", timestampMs: timestampMs + 100 },
    ];

    const split = splitHistoryMessages(messages, { startedAt: timestampMs, spinnerVisible: false }, "a1");

    expect(split.finalized.map((message) => message.id)).toEqual(["u1"]);
    expect(split.live.map((message) => message.id)).toEqual(["a1"]);
  });

  it("uses Static for finalized history output", () => {
    const element = History({
      pendingTurn: null,
      liveAssistantId: null,
      messages: [{ id: "u1", role: "user", content: "hello", timestampMs: Date.now() }],
    });
    const fragment = React.Children.toArray((element.props as { children: React.ReactNode }).children)[0] as React.ReactElement;
    const children = React.Children.toArray((fragment.props as { children: React.ReactNode }).children) as React.ReactElement[];

    expect(children[0]?.type).toBe(Static);
  });

  it("renders the footer with model, live session time, cost, and tokens", () => {
    const sessionStartMs = new Date(2026, 4, 17, 12, 0, 0).getTime();
    vi.useFakeTimers();
    vi.setSystemTime(sessionStartMs + 65_000);

    const { lastFrame } = render(
      <Footer
        provider="deepseek"
        model="deepseek-v4-pro"
        sessionStartMs={sessionStartMs}
        now={sessionStartMs + 65_000}
        stats={{ costUsd: 0.0123, totalTokens: 12_345 }}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("deepseek:deepseek-v4-pro");
    expect(frame).toContain("session 1m 5s");
    expect(frame).toContain("$0.012");
    expect(frame).toContain("12.3k tokens");
    expect(frame).not.toContain("┌");
  });

  it("computes the spinner frame and counter from the current system clock", () => {
    const startedAt = new Date(2026, 4, 17, 12, 0, 0).getTime();
    vi.useFakeTimers();

    vi.setSystemTime(startedAt);
    const initial = render(<Spinner startedAt={startedAt} />);
    expect(initial.lastFrame()).toContain("thinking… (0s)");
    expect(initial.lastFrame()).toContain("⠋");
    initial.unmount();

    vi.setSystemTime(startedAt + 240);
    const after240 = render(<Spinner startedAt={startedAt} />);
    expect(after240.lastFrame()).toContain("thinking… (0s)");
    expect(after240.lastFrame()).toContain("⠹");
    after240.unmount();

    vi.setSystemTime(startedAt + 2400);
    const after2400 = render(<Spinner startedAt={startedAt} />);
    expect(after2400.lastFrame()).toContain("thinking… (2s)");
    after2400.unmount();
  });

  it("renders the input box in a disabled style while a turn is active", () => {
    const startedAt = new Date(2026, 4, 17, 12, 0, 0).getTime();
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);

    const { lastFrame } = render(<Input disabled pendingStartedAt={startedAt} now={startedAt} onSubmit={() => {}} onExit={() => {}} />);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("[12:00:00] >");
    expect(frame).toContain("…");
    expect(frame).not.toContain("thinking…");
    expect(frame).toMatch(/[╭╮╰╯]/);
  });

  it("keeps the input clock pinned to the shared clock prop", () => {
    const shownAt = new Date(2026, 4, 17, 12, 0, 0).getTime();
    const { lastFrame, rerender } = render(<Input now={shownAt} onSubmit={() => {}} onExit={() => {}} />);

    expect(lastFrame()).toContain("[12:00:00] >");

    rerender(<Input now={shownAt} onSubmit={() => {}} onExit={() => {}} />);

    expect(lastFrame()).toContain("[12:00:00] >");
  });

  it("renders live activity for reasoning and tools inside a bordered box", () => {
    const startedAt = new Date(2026, 4, 17, 12, 0, 0).getTime();
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);

    const { lastFrame } = render(
      <ActivityPanel
        pendingStartedAt={startedAt}
        items={[
          { id: "r1", kind: "reasoning", status: "active", summary: "thinking…", content: "checking files", startedAt: 1 },
          { id: "t1", kind: "tool", status: "done", summary: "list_files: 23 files", startedAt: 2, endedAt: 3 },
        ]}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("thinking…");
    expect(frame).toContain("checking files");
    expect(frame).toContain("list_files: 23 files");
    expect(frame).toMatch(/[╭╮╰╯]/);
  });

  it("renders nothing when there is no pending turn and no items", () => {
    const { lastFrame } = render(<ActivityPanel items={[]} />);
    expect(lastFrame() ?? "").toBe("");
  });

  it("accumulates activity progress and clears it when the turn completes", () => {
    let state = createInitialInkState();
    state = inkReducer(state, {
      type: "activity_start",
      item: { id: "r1", kind: "reasoning", status: "active", summary: "thinking…", startedAt: 1 },
    });
    state = inkReducer(state, { type: "activity_progress", id: "r1", text: "hello" });
    state = inkReducer(state, { type: "turn_complete", elapsedMs: 10 });

    expect(state.activityItems).toEqual([]);
  });

  it("seeds the warmup banner in the initial Ink state", () => {
    const state = createInitialInkState({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      now: new Date(2026, 4, 17, 12, 0, 0).getTime(),
    });

    expect(state.messages[0]?.content).toBe("Tanya · connecting to deepseek:deepseek-v4-pro…");
  });

  it("renders App initialMessages through reducer-backed Static history", () => {
    const provider: ChatProvider = {
      id: "deepseek",
      model: "deepseek-chat",
      async *streamChat() {},
    };
    const timestampMs = new Date(2026, 4, 17, 12, 0, 0).getTime();

    const { lastFrame } = render(
      <App
        provider={provider}
        cwd={process.cwd()}
        initialMessages={[
          { id: "resume-banner", role: "system", content: "Resumed session 20260517-214851-abc123 · 1 turns", timestampMs },
          { id: "resume-user", role: "user", content: "previous prompt", timestampMs },
        ]}
        initialTurnCount={1}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Resumed session 20260517-214851-abc123");
    expect(frame).toContain("previous prompt");
  });
});

describe("SessionPicker", () => {
  const sessions = [
    { id: "20260601-aaa", createdAt: "2026-06-01T10:00:00Z", lastUpdatedAt: "2026-06-01T10:00:00Z", cwd: "/p", provider: "deepseek", model: "m", label: "first session", turnCount: 3, costUsd: 0, path: "/p/a", scope: "project" as const },
    { id: "20260602-bbb", createdAt: "2026-06-02T10:00:00Z", lastUpdatedAt: "2026-06-02T10:00:00Z", cwd: "/p", provider: "deepseek", model: "m", label: "second session", turnCount: 1, costUsd: 0, path: "/p/b", scope: "project" as const },
  ];

  it("renders the list and resumes the highlighted session on Enter", async () => {
    const onSelect = vi.fn();
    const { lastFrame, stdin } = render(
      <SessionPicker sessions={sessions} onSelect={onSelect} onCancel={() => {}} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Resume a session");
    expect(frame).toContain("first session");
    expect(frame).toContain("second session");

    // Let useInput subscribe before the first keypress.
    await new Promise((resolve) => setTimeout(resolve, 10));
    stdin.write("\u001B[B"); // arrow down -> second entry
    await new Promise((resolve) => setTimeout(resolve, 10));
    stdin.write("\r"); // enter
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onSelect).toHaveBeenCalledWith("20260602-bbb");
  });

  it("cancels on Escape", async () => {
    const onCancel = vi.fn();
    const { stdin } = render(<SessionPicker sessions={sessions} onSelect={() => {}} onCancel={onCancel} />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    stdin.write("\u001B");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onCancel).toHaveBeenCalled();
  });

  it("renders an empty notice when there are no sessions", () => {
    const { lastFrame } = render(<SessionPicker sessions={[]} onSelect={() => {}} onCancel={() => {}} />);
    expect(lastFrame() ?? "").toContain("No saved sessions found");
  });

  it("renders nothing while closed", () => {
    const { lastFrame } = render(<SessionPicker sessions={null} onSelect={() => {}} onCancel={() => {}} />);
    expect((lastFrame() ?? "").trim()).toBe("");
  });
});

describe("append_session_replay", () => {
  it("appends replayed turns after the already-rendered messages (Static can never unprint)", () => {
    let state = createInitialInkState({ provider: "deepseek", model: "m" });
    state = inkReducer(state, { type: "system_message", content: "ready." });
    const before = state.messages.length;
    state = inkReducer(state, {
      type: "append_session_replay",
      messages: [
        { id: "r-0", role: "user", content: "old prompt", timestampMs: 1 },
        { id: "r-1", role: "assistant", content: "old answer", timestampMs: 2 },
        { id: "r-banner", role: "system", content: "Resumed session abc", timestampMs: 3 },
      ],
      stats: { costUsd: 0.5, totalTokens: 100 },
      generateMs: 1000,
      turnCount: 1,
    });
    // Appended, not replaced: the messages Static already printed stay in
    // place and the replayed chat lands after them, so it actually renders.
    expect(state.messages.length).toBe(before + 3);
    expect(state.messages.slice(0, before).map((m) => m.id)).toEqual(
      Array.from({ length: before }, (_, i) => state.messages[i]?.id),
    );
    expect(state.messages.at(-3)?.content).toBe("old prompt");
    expect(state.messages.at(-1)?.content).toBe("Resumed session abc");
    expect(state.turnCount).toBe(1);
    expect(state.stats.totalTokens).toBe(100);
  });
});
