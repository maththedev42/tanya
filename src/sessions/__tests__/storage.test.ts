import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendTurn,
  createSession,
  findContinueSession,
  listSessions,
  loadSession,
  materialize,
  resolveSessionsDir,
} from "../storage";

afterEach(() => {
  vi.restoreAllMocks();
});

function tempRoot(name: string): string {
  return mkdtempSync(join(tmpdir(), name));
}

function project(name = "tanya-session-project-"): string {
  const cwd = tempRoot(name);
  mkdirSync(join(cwd, ".tanya"), { recursive: true });
  return cwd;
}

describe("session storage", () => {
  it("round-trips appended turns through materialized JSON", () => {
    const cwd = project();
    const session = createSession({
      cwd,
      provider: "deepseek",
      model: "deepseek-chat",
      id: "20260517-214851-abc123",
      now: new Date("2026-05-17T21:48:51.234Z"),
    });

    for (let i = 0; i < 5; i += 1) {
      appendTurn(session.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i}`,
        timestampMs: Date.parse("2026-05-17T21:49:00.000Z") + i,
        ...(i % 2 === 1 ? { elapsedMs: 1000, metrics: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0 } } : { elapsedMs: null }),
      });
    }

    const materialized = materialize(session.id, { cwd });
    const loaded = loadSession("abc", { cwd }).session;
    const normalize = (value: typeof loaded) => ({ ...value, lastUpdatedAt: "<ignored>" });

    expect(normalize(loaded)).toEqual(normalize(materialized));
    expect(loaded.turns).toHaveLength(5);
    expect(loaded.sessionStats.turnCount).toBe(2);
    expect(existsSync(join(cwd, ".tanya", "sessions", ".gitignore"))).toBe(true);
    expect(readFileSync(join(cwd, ".tanya", "sessions", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("prices persisted cache-hit prompt tokens at the discounted rate", () => {
    const cwd = project();
    const session = createSession({
      cwd,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      id: "20260517-214851-cac4e0",
    });
    // One assistant turn whose prompt was entirely a cache hit. buildStats must
    // bill those at the cache-hit rate ($0.003625/M), not the ~120× dearer miss
    // rate ($0.435/M) — otherwise the sidebar overstates spend in a way the live
    // footer (which already carries the cache split) never did.
    appendTurn(session.id, { role: "user", content: "q", timestampMs: 1, elapsedMs: null });
    appendTurn(session.id, {
      role: "assistant",
      content: "a",
      timestampMs: 2,
      elapsedMs: 10,
      metrics: { promptTokens: 1_000_000, completionTokens: 0, reasoningTokens: 0, cachedPromptTokens: 1_000_000 },
    });
    materialize(session.id, { cwd });

    const loaded = loadSession(session.id, { cwd }).session;
    // 1M cache-hit prompt tokens × $0.003625/M ≈ $0.003625; the miss rate would be $0.435.
    expect(loaded.sessionStats.costUsd).toBeCloseTo(0.003625, 6);
    expect(loaded.turns.at(-1)?.metrics?.cachedPromptTokens).toBe(1_000_000);
  });

  it("recovers valid JSONL lines and warns about a corrupt tail", () => {
    const cwd = project();
    const session = createSession({
      cwd,
      provider: "deepseek",
      model: "deepseek-chat",
      id: "20260517-214851-def456",
    });
    appendTurn(session.id, { role: "user", content: "one", timestampMs: 1, elapsedMs: null });
    appendTurn(session.id, { role: "assistant", content: "two", timestampMs: 2, elapsedMs: 10 });
    appendTurn(session.id, { role: "user", content: "three", timestampMs: 3, elapsedMs: null });
    appendFileSync(join(cwd, ".tanya", "sessions", `${session.id}.jsonl`), "{bad json\n", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const loaded = loadSession(session.id, { cwd });

    expect(loaded.session.turns.map((turn) => turn.content)).toEqual(["one", "two", "three"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ignored corrupt session JSONL line 4"));
  });

  it("walks parent directories until it finds .tanya", () => {
    const cwd = project();
    const child = join(cwd, "packages", "app");
    mkdirSync(child, { recursive: true });

    expect(resolveSessionsDir({ cwd: child }).dir).toBe(join(cwd, ".tanya", "sessions"));
  });

  it("falls back to global sessions when no project .tanya exists", () => {
    const cwd = tempRoot("tanya-session-no-project-");
    const homeDir = tempRoot("tanya-session-home-");
    const session = createSession({
      cwd,
      homeDir,
      provider: "deepseek",
      model: "deepseek-chat",
      id: "20260517-220000-fed001",
    });
    appendTurn(session.id, { role: "user", content: "global hello", timestampMs: Date.now(), elapsedMs: null });
    materialize(session.id, { cwd, homeDir });

    const continued = findContinueSession({ cwd, homeDir });

    expect(continued?.session.id).toBe(session.id);
    expect(continued?.scope).toBe("global");
  });

  it("continues the most recent matching project session from a child cwd", () => {
    const cwd = project();
    const child = join(cwd, "src");
    mkdirSync(child, { recursive: true });
    const session = createSession({
      cwd,
      provider: "deepseek",
      model: "deepseek-chat",
      id: "20260517-221000-aabbcc",
    });
    appendTurn(session.id, { role: "user", content: "project hello", timestampMs: Date.now(), elapsedMs: null });
    materialize(session.id, { cwd });

    expect(findContinueSession({ cwd: child })?.session.id).toBe(session.id);
  });

  it("resolves unique short-id prefixes and errors on ambiguity", () => {
    const cwd = project();
    createSession({ cwd, provider: "deepseek", model: "deepseek-chat", id: "20260517-214851-abc123" });
    createSession({ cwd, provider: "deepseek", model: "deepseek-chat", id: "20260517-214852-def123" });

    expect(loadSession("abc", { cwd }).session.id).toBe("20260517-214851-abc123");

    createSession({ cwd, provider: "deepseek", model: "deepseek-chat", id: "20260517-214853-abc999" });
    expect(() => loadSession("abc", { cwd })).toThrow(/ambiguous/);
  });

  it("lists sessions in a stable recent-first order", () => {
    const cwd = project();
    const homeDir = tempRoot("tanya-home-");
    const older = createSession({ cwd, provider: "deepseek", model: "deepseek-chat", id: "20260517-100000-111111" });
    const newer = createSession({ cwd, provider: "deepseek", model: "deepseek-chat", id: "20260517-110000-222222" });
    appendTurn(older.id, { role: "user", content: "older", timestampMs: Date.parse("2026-05-17T10:00:01.000Z"), elapsedMs: null });
    appendTurn(newer.id, { role: "user", content: "newer", timestampMs: Date.parse("2026-05-17T11:00:01.000Z"), elapsedMs: null });

    expect(listSessions({ cwd, homeDir }).map((session) => session.id)).toEqual([newer.id, older.id]);
  });

  it("does not treat the home ~/.tanya as a project marker", () => {
    const home = tempRoot("tanya-home-");
    mkdirSync(join(home, ".tanya"), { recursive: true }); // Tanya's global dir exists
    const cwd = join(home, "workspace");
    mkdirSync(cwd, { recursive: true }); // a folder under home with no project .tanya
    const resolved = resolveSessionsDir({ cwd, homeDir: home });
    expect(resolved.scope).toBe("global");
    expect(resolved.dir).toBe(join(home, ".tanya", "sessions", "global"));
  });

  it("recovers sessions written directly under ~/.tanya/sessions (legacy layout)", () => {
    const home = tempRoot("tanya-home-");
    const legacyDir = join(home, ".tanya", "sessions");
    mkdirSync(legacyDir, { recursive: true });
    const cwd = join(home, "proj");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(legacyDir, "20260101-000000-legacy.json"), JSON.stringify({
      id: "20260101-000000-legacy",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUpdatedAt: "2026-01-01T00:00:00.000Z",
      cwd,
      provider: "deepseek",
      model: "deepseek-chat",
      turns: [],
      sessionStats: { elapsedMs: 0, generateMs: 0, turnCount: 0, costUsd: 0, totalTokens: 0 },
      label: "legacy session",
    }));

    const ids = listSessions({ cwd, homeDir: home, all: true }).map((session) => session.id);
    expect(ids).toContain("20260101-000000-legacy");
  });
});
