import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearExitSentinelHeartbeats, flushExitSentinelHeartbeat, registerExitSentinel, writeExitSentinel } from "../exitSentinel";
import { runAgent } from "../runner";
import type { ChatProvider, ToolCall } from "../../providers/types";

// Exit sentinel (PROMPT B2 items 1–2). The audited failure died mid-work:
// 6 files created, zero builds, no report phase — so the report-time gates
// never armed, no archive landed, and a tree with ~20 compile errors was
// handed over in silence.

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tanya-sentinel-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@e.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "base.ts"), "export {};\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function sentinelState(workspace: string, overrides: Partial<Parameters<typeof writeExitSentinel>[0]> = {}) {
  return {
    runId: "r-test-abc",
    workspace,
    prompt: "do the thing",
    changedFiles: [] as string[],
    verificationEvents: [] as { line: string; atMs: number }[],
    archived: false,
    heartbeatRepos: new Set<string>(),
    unregister: () => {},
    ...overrides,
  };
}

describe("writeExitSentinel", () => {
  it("writes the aborted archive + loud marker for a dirty death (changed sources, no green build)", () => {
    const dir = initRepo();
    writeFileSync(join(dir, "Broken.swift"), "let x: Invented = 1\n"); // uncommitted
    const state = sentinelState(dir, {
      changedFiles: ["Broken.swift"],
      terminationReason: "signal: SIGTERM",
    });
    writeExitSentinel(state);

    const archive = JSON.parse(readFileSync(join(dir, ".tanya", "runs", "r-test-abc.json"), "utf8"));
    expect(archive.aborted).toBe(true);
    expect(archive.terminationReason).toBe("signal: SIGTERM");
    expect(archive.changedFiles).toEqual(["Broken.swift"]);
    expect(archive.uncommittedFiles).toContain("Broken.swift");
    expect(archive.greenBuildObserved).toBe(false);
    expect(archive.verdict).toBe("FAIL");

    const marker = readFileSync(join(dir, ".tanya", "LAST_RUN_FAILED.md"), "utf8");
    expect(marker).toContain("TREE MAY NOT COMPILE");
    expect(marker).toContain("Broken.swift");
    expect(marker).toContain("signal: SIGTERM");
  });

  it("writes the archive but NO marker when the death left a safe tree (green build, everything committed)", () => {
    const dir = initRepo();
    // Changed file was committed; a green authoritative build ran.
    const state = sentinelState(dir, {
      changedFiles: ["base.ts"],
      verificationEvents: [{ line: "Verification: npm test -> passed (ok)", atMs: Date.now() }],
      terminationReason: "exception: sink died",
    });
    writeExitSentinel(state);

    expect(existsSync(join(dir, ".tanya", "runs", "r-test-abc.json"))).toBe(true);
    expect(existsSync(join(dir, ".tanya", "LAST_RUN_FAILED.md"))).toBe(false);
  });

  it("is a no-op once the real archive landed (archived=true)", () => {
    const dir = initRepo();
    const state = sentinelState(dir, { archived: true, changedFiles: ["base.ts"] });
    writeExitSentinel(state);
    expect(existsSync(join(dir, ".tanya", "runs", "r-test-abc.json"))).toBe(false);
    expect(existsSync(join(dir, ".tanya", "LAST_RUN_FAILED.md"))).toBe(false);
  });

  it("registerExitSentinel exposes live state and clean unregister", () => {
    const dir = initRepo();
    const before = process.listenerCount("SIGINT");
    const state = registerExitSentinel({
      runId: "r-live",
      workspace: dir,
      prompt: "p",
      changedFiles: [],
      verificationEvents: [],
    });
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    state.unregister();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});

describe("runAgent exception path", () => {
  function toolCall(id: string, name: string, args: unknown): ToolCall {
    return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
  }

  it("a run that dies mid-finalize still leaves an aborted archive + marker", async () => {
    const dir = initRepo();
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        const wroteAlready = input.messages.some((m) => m.role === "tool");
        if (!wroteAlready) {
          yield { toolCalls: [toolCall("c1", "write_file", { path: "New.swift", content: "let a = 1\n" })] };
          return;
        }
        yield { content: "Done." };
      },
    };

    // The sink dies on the final event — the run wrote a source file, never
    // built, and the process never completes its report. Exactly the audited
    // shape, driven deterministically.
    await expect(
      runAgent({
        provider,
        prompt: "write the file",
        cwd: dir,
        sink: async (event) => {
          if (event.type === "final") throw new Error("host died mid-finalize");
        },
        maxTurns: 3,
      }),
    ).rejects.toThrow(/host died mid-finalize/);

    const runsDir = join(dir, ".tanya", "runs");
    const archives = readdirSync(runsDir).filter((name) => name.endsWith(".json"));
    expect(archives.length).toBeGreaterThan(0);
    const archive = JSON.parse(readFileSync(join(runsDir, archives[0]!), "utf8"));
    expect(archive.aborted).toBe(true);
    expect(archive.terminationReason).toMatch(/exception: host died mid-finalize/);
    expect(archive.changedFiles).toContain("New.swift");
    expect(archive.greenBuildObserved).toBe(false);
    // The dirty tree gets the loud marker: uncommitted source, no green build.
    const marker = readFileSync(join(dir, ".tanya", "LAST_RUN_FAILED.md"), "utf8");
    expect(marker).toContain("New.swift");
  }, 30_000);
});

// PROMPT B3: artifacts must follow the TARGET repo. A serve session driven
// from a workspace ROOT (mac app --cwd Appzinhos) edits nested repos; the
// FinanceWorld run-3 audit looked in the nested repo's .tanya, found nothing,
// and concluded the gates never fired — they had, one directory up.
describe("multi-repo placement", () => {
  function initNestedRepo(workspace: string, name: string): string {
    const sub = join(workspace, name);
    mkdirSync(sub, { recursive: true });
    git(sub, ["init", "-q"]);
    git(sub, ["config", "user.email", "t@e.com"]);
    git(sub, ["config", "user.name", "T"]);
    git(sub, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(sub, "base.ts"), "export {};\n");
    git(sub, ["add", "-A"]);
    git(sub, ["commit", "-q", "-m", "init"]);
    return sub;
  }

  it("a dirty death in a nested repo leaves marker + archive pointer THERE, archive at the workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-sentinel-ws-")); // NOT a git repo
    const sub = initNestedRepo(workspace, "TargetApp");
    writeFileSync(join(sub, "Broken.swift"), "let x: Invented = 1\n"); // uncommitted
    const state = sentinelState(workspace, {
      changedFiles: ["TargetApp/Broken.swift"],
      terminationReason: "signal: SIGTERM",
    });
    writeExitSentinel(state);

    // Session archive at the workspace, as before.
    expect(existsSync(join(workspace, ".tanya", "runs", "r-test-abc.json"))).toBe(true);
    // The loud marker lands in the repo that actually holds the hazard.
    const marker = readFileSync(join(sub, ".tanya", "LAST_RUN_FAILED.md"), "utf8");
    expect(marker).toContain("TREE MAY NOT COMPILE");
    expect(marker).toContain("Broken.swift");
    // And a pointer makes the workspace archive one hop away from the repo.
    const pointer = readFileSync(join(sub, ".tanya", "runs", "r-test-abc.at"), "utf8").trim();
    expect(pointer).toBe(join(workspace, ".tanya", "runs", "r-test-abc.json"));
  });

  it("a clean nested repo (no changed files there) gets no marker", () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-sentinel-ws2-"));
    const sub = initNestedRepo(workspace, "Untouched");
    const state = sentinelState(workspace, { changedFiles: [], terminationReason: "signal: SIGTERM" });
    writeExitSentinel(state);
    expect(existsSync(join(sub, ".tanya", "LAST_RUN_FAILED.md"))).toBe(false);
  });
});

// The mac app executes EVERY turn through runAgent({interactive: true}) — the
// beta.9 gate escape happened because gates keyed on !interactive. The
// sentinel must be transport-agnostic.
describe("interactive (serve-turn) coverage", () => {
  it("a dirty death in an interactive turn still writes marker + aborted archive", async () => {
    const dir = initRepo();
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        const wroteAlready = input.messages.some((m) => m.role === "tool");
        if (!wroteAlready) {
          yield { toolCalls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "New.swift", content: "let a = 1\n" }) } }] };
          return;
        }
        yield { content: "Done." };
      },
    };
    await expect(
      runAgent({
        provider,
        prompt: "write the file",
        cwd: dir,
        interactive: true,
        sink: async (event) => {
          if (event.type === "final") throw new Error("serve host died");
        },
        maxTurns: 3,
      }),
    ).rejects.toThrow(/serve host died/);
    expect(existsSync(join(dir, ".tanya", "LAST_RUN_FAILED.md"))).toBe(true);
    const archives = readdirSync(join(dir, ".tanya", "runs")).filter((name) => name.endsWith(".json"));
    expect(archives.length).toBeGreaterThan(0);
  });
});

// kill -9 cannot be caught: the heartbeat is the only artifact that survives
// it. Every graceful end removes it, so a surviving heartbeat IS the marker.
describe("kill -9 heartbeat (RUN_IN_PROGRESS.md)", () => {
  it("flush writes it into the touched nested repo; clear removes it; a sentinel write supersedes it", () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-sentinel-hb-"));
    const sub = join(workspace, "TargetApp");
    mkdirSync(sub, { recursive: true });
    git(sub, ["init", "-q"]);
    writeFileSync(join(sub, "Broken.swift"), "let x = 1\n");
    const state = sentinelState(workspace, { changedFiles: ["TargetApp/Broken.swift"] });

    flushExitSentinelHeartbeat(state);
    const heartbeatPath = join(sub, ".tanya", "RUN_IN_PROGRESS.md");
    const heartbeat = readFileSync(heartbeatPath, "utf8");
    expect(heartbeat).toContain("r-test-abc");
    expect(heartbeat).toContain(String(process.pid));

    clearExitSentinelHeartbeats(state);
    expect(existsSync(heartbeatPath)).toBe(false);

    flushExitSentinelHeartbeat(state);
    state.terminationReason = "signal: SIGTERM";
    writeExitSentinel(state);
    expect(existsSync(heartbeatPath)).toBe(false); // superseded by the marker
    expect(existsSync(join(sub, ".tanya", "LAST_RUN_FAILED.md"))).toBe(true);
  });

  it("never removes another run's heartbeat", () => {
    const dir = initRepo();
    const heartbeatPath = join(dir, ".tanya", "RUN_IN_PROGRESS.md");
    mkdirSync(join(dir, ".tanya"), { recursive: true });
    writeFileSync(heartbeatPath, "# Tanya run r-OTHER in progress\n");
    const state = sentinelState(dir, {});
    state.heartbeatRepos.add(dir);
    clearExitSentinelHeartbeats(state);
    expect(existsSync(heartbeatPath)).toBe(true);
  });

  it("the runner flushes on the first mutating write and a clean finalize removes it", async () => {
    const dir = initRepo();
    let seenDuringRun = false;
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat(input) {
        const wroteAlready = input.messages.some((m) => m.role === "tool");
        if (!wroteAlready) {
          yield { toolCalls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "a.ts", content: "export {};\n" }) } }] };
          return;
        }
        // Second turn: the first turn's write has been flushed by now.
        seenDuringRun = existsSync(join(dir, ".tanya", "RUN_IN_PROGRESS.md"));
        yield { content: "Done." };
      },
    };
    await runAgent({ provider, prompt: "write the file", cwd: dir, sink: async () => {}, maxTurns: 3 });
    expect(seenDuringRun).toBe(true);
    expect(existsSync(join(dir, ".tanya", "RUN_IN_PROGRESS.md"))).toBe(false);
  }, 30_000);
});
