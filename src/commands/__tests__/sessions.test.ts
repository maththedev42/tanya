import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../index";
import { appendTurn, createSession, materialize } from "../../sessions/storage";
import { ChatSessionController } from "../../sessions/repl";
import type { ChatMessage } from "../../providers/types";
import type { TanyaEvent } from "../../events/types";

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "tanya-slash-sessions-"));
  mkdirSync(join(cwd, ".tanya"), { recursive: true });
  return cwd;
}

describe("session slash commands", () => {
  it("confirms before discarding unsaved turns on /resume", async () => {
    const cwd = project();
    const saved = createSession({ cwd, provider: "deepseek", model: "deepseek-chat", id: "20260517-214851-abc123" });
    appendTurn(saved.id, { role: "user", content: "saved prompt", timestampMs: 1, elapsedMs: null });
    appendTurn(saved.id, { role: "assistant", content: "saved answer", timestampMs: 2, elapsedMs: 1 });
    materialize(saved.id, { cwd });

    const current = createSession({ cwd, provider: "deepseek", model: "deepseek-chat", id: "20260517-214852-def123" });
    const controller = new ChatSessionController(current);
    controller.unsavedTurnCount = 1;
    const output = new MemoryStream();
    const history: ChatMessage[] = [{ role: "user", content: "scratch" }];
    const events: TanyaEvent[] = [];
    let asked = "";

    await runCommand("/resume abc", {
      cwd,
      output: output as unknown as NodeJS.WritableStream,
      sink: (event) => {
        events.push(event);
      },
      history,
      sessionController: controller,
      onPermissionRequest: async (request) => {
        asked = (request.input as { question: string }).question;
        return { decision: "allow" };
      },
    });

    expect(asked).toContain("Current session has 1 turn. Discard and resume abc?");
    expect(history.map((message) => message.content)).toEqual(["saved prompt", "saved answer"]);
    expect(output.chunks.join("")).toContain("Resumed session 20260517-214851-abc123");
    expect(events).toContainEqual({ type: "command_invoked", name: "resume", args: ["abc"] });
  });

  it("cancels /resume when confirmation is denied", async () => {
    const cwd = project();
    createSession({ cwd, provider: "deepseek", model: "deepseek-chat", id: "20260517-214851-abc123" });
    const current = createSession({ cwd, provider: "deepseek", model: "deepseek-chat", id: "20260517-214852-def123" });
    const controller = new ChatSessionController(current);
    controller.unsavedTurnCount = 2;
    const output = new MemoryStream();
    const history: ChatMessage[] = [{ role: "user", content: "scratch" }];

    await runCommand("/resume abc", {
      cwd,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
      history,
      sessionController: controller,
      onPermissionRequest: async () => ({ decision: "deny" }),
    });

    expect(history).toEqual([{ role: "user", content: "scratch" }]);
    expect(output.chunks.join("")).toContain("Resume cancelled.");
  });

  it("hands the resumed session to onSessionResumed without double-writing the banner", async () => {
    const cwd = project();
    const saved = createSession({ cwd, provider: "deepseek", model: "deepseek-chat", id: "20260517-214851-abc123" });
    appendTurn(saved.id, { role: "user", content: "saved prompt", timestampMs: 1, elapsedMs: null });
    appendTurn(saved.id, { role: "assistant", content: "saved answer", timestampMs: 2, elapsedMs: 1 });
    materialize(saved.id, { cwd });

    const current = createSession({ cwd, provider: "deepseek", model: "deepseek-chat", id: "20260517-214852-def123" });
    const controller = new ChatSessionController(current);
    const output = new MemoryStream();
    let resumedId = "";

    await runCommand("/resume abc", {
      cwd,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
      sessionController: controller,
      onSessionResumed: (session) => {
        resumedId = session.id;
      },
    });

    expect(resumedId).toBe("20260517-214851-abc123");
    // The host renders banner + replayed chat itself.
    expect(output.chunks.join("")).not.toContain("Resumed session");
  });

  it("/resume with no id opens the session picker when the host provides one", async () => {
    const cwd = project();
    const saved = createSession({ cwd, provider: "deepseek", model: "deepseek-chat", id: "20260517-214851-abc123" });
    appendTurn(saved.id, { role: "user", content: "saved prompt", timestampMs: 1, elapsedMs: null });
    materialize(saved.id, { cwd });

    const output = new MemoryStream();
    let pickerSessions: unknown[] | null = null;
    await runCommand("/resume", {
      cwd,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
      openSessionPicker: (sessions) => {
        pickerSessions = sessions;
      },
    });

    expect(pickerSessions).not.toBeNull();
    expect((pickerSessions as unknown as Array<{ id: string }>).map((s) => s.id)).toContain("20260517-214851-abc123");
    // The picker host owns the UI — no usage text on this path.
    expect(output.chunks.join("")).not.toContain("Usage: /resume");
  });

  it("/resume with no id falls back to a printed session list without a picker host", async () => {
    const cwd = project();
    const saved = createSession({ cwd, provider: "deepseek", model: "deepseek-chat", id: "20260517-214851-abc123" });
    appendTurn(saved.id, { role: "user", content: "saved prompt", timestampMs: 1, elapsedMs: null });
    materialize(saved.id, { cwd });

    const output = new MemoryStream();
    await runCommand("/resume", {
      cwd,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
    });

    const text = output.chunks.join("");
    expect(text).toContain("20260517-214851-abc123");
    expect(text).toContain("Usage: /resume <id>");
  });
});
