import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSessionList, parseDurationMs, runSessionsCommand, toSessionListJson } from "../sessionsCommand";
import { createSession, listSessions } from "../../sessions/storage";
import type { SessionSummary } from "../../sessions/types";

class StringSink {
  chunks: string[] = [];
  write(value: string): boolean {
    this.chunks.push(value);
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
  /** The command only calls `.write`; expose it as a WritableStream for the API. */
  get stream(): NodeJS.WritableStream {
    return this as unknown as NodeJS.WritableStream;
  }
}

function projectDir(): string {
  const cwd = mkdtempSync(join(tmpdir(), "tanya-rename-cmd-"));
  mkdirSync(join(cwd, ".tanya"), { recursive: true });
  return cwd;
}

const sampleSession: SessionSummary = {
  id: "20260517-214851-abc123",
  createdAt: "2026-05-17T21:48:51.234Z",
  lastUpdatedAt: "2026-05-17T21:57:00.000Z",
  cwd: "/tmp/project",
  provider: "deepseek",
  model: "deepseek-chat",
  label: "Add a /search endpoint to the notes API and run the tests",
  turnCount: 12,
  costUsd: 0.0342,
  path: "/tmp/project/.tanya/sessions/20260517-214851-abc123.json",
  scope: "project",
};

describe("sessions command formatting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats list output in fixed readable columns", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T22:00:00.000Z"));

    expect(formatSessionList([sampleSession], 100)).toMatchInlineSnapshot(`
      "ID                       AGE        TURNS  LABEL
      20260517-214851-abc123   3 min ago     12 Add a /search endpoint to the notes API and run the tests
      "
    `);
  });

  it("projects a stable JSON shape for the app (no internal path field)", () => {
    expect(toSessionListJson(sampleSession)).toEqual({
      id: "20260517-214851-abc123",
      label: "Add a /search endpoint to the notes API and run the tests",
      cwd: "/tmp/project",
      provider: "deepseek",
      model: "deepseek-chat",
      createdAt: "2026-05-17T21:48:51.234Z",
      lastUpdatedAt: "2026-05-17T21:57:00.000Z",
      turnCount: 12,
      costUsd: 0.0342,
      scope: "project",
    });
  });

  it("falls back to (untitled) for empty labels in JSON", () => {
    expect(toSessionListJson({ ...sampleSession, label: "" }).label).toBe("(untitled)");
  });

  it("parses prune durations", () => {
    expect(parseDurationMs("30d")).toBe(30 * 86_400_000);
    expect(parseDurationMs("12h")).toBe(12 * 3_600_000);
  });

  it("renames a session, joining a multi-word label", async () => {
    const cwd = projectDir();
    const session = createSession({ cwd, provider: "deepseek", model: "deepseek-chat" });
    const output = new StringSink();

    await runSessionsCommand({
      action: "rename",
      args: [session.id, "Fix", "the", "login", "bug"],
      cwd,
      output: output.stream,
    });

    expect(output.text).toContain('to "Fix the login bug"');
    expect(listSessions({ cwd, all: true }).find((s) => s.id === session.id)?.label).toBe("Fix the login bug");
  });

  it("rejects a rename with no label", async () => {
    const cwd = projectDir();
    const session = createSession({ cwd, provider: "deepseek", model: "deepseek-chat" });
    await expect(
      runSessionsCommand({ action: "rename", args: [session.id], cwd, output: new StringSink().stream }),
    ).rejects.toThrow(/Usage: tanya sessions rename/);
  });
});
