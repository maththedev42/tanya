import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExecutor, listExecutors, executorEnv } from "../src/executors/index";
import type { ExecutorId } from "../src/executors/types";

describe("executor registry", () => {
  it("resolves claude executor by id", () => {
    const executor = resolveExecutor("claude");
    expect(executor).toBeDefined();
    expect(executor!.id).toBe("claude");
    expect(executor!.binary).toBe("claude");
  });

  it("resolves codex executor by id", () => {
    const executor = resolveExecutor("codex");
    expect(executor).toBeDefined();
    expect(executor!.id).toBe("codex");
    expect(executor!.binary).toBe("codex");
  });

  it("resolves cursor executor by id", () => {
    const executor = resolveExecutor("cursor");
    expect(executor).toBeDefined();
    expect(executor!.id).toBe("cursor");
    expect(executor!.binary).toBe("cursor-agent");
  });

  it("returns undefined for unknown executor id", () => {
    const executor = resolveExecutor("unknown" as ExecutorId);
    expect(executor).toBeUndefined();
  });

  // Hermetic: point PATH at an empty dir so the probes ENOENT immediately —
  // unit tests must never invoke the real installed CLIs (overview rule), and
  // a real `claude auth status` probe is also far slower than the test budget.
  it("listExecutors returns all three, unavailable when no binary is on PATH", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "tanya-empty-path-"));
    const savedPath = process.env.PATH;
    process.env.PATH = emptyDir;
    try {
      const executors = await listExecutors();
      expect(executors).toHaveLength(3);
      const ids = executors.map((e) => e.id).sort();
      expect(ids).toEqual(["claude", "codex", "cursor"]);
      for (const entry of executors) {
        expect(entry.available).toBe(false);
      }
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("executorEnv", () => {
  it("strips TANYA_* vars", () => {
    const env = executorEnv({
      HOME: "/home/user",
      PATH: "/usr/bin",
      TANYA_FOO: "bar",
      TANYA_BAZ: "qux",
      MY_APP: "keep",
    });
    expect(env.HOME).toBe("/home/user");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.MY_APP).toBe("keep");
    expect(env.TANYA_FOO).toBeUndefined();
    expect(env.TANYA_BAZ).toBeUndefined();
  });

  it("strips provider API key vars", () => {
    const env = executorEnv({
      HOME: "/home/user",
      ANTHROPIC_API_KEY: "sk-ant-123",
      ANTHROPIC_BASE_URL: "https://custom.anthropic.com",
      OPENAI_API_KEY: "sk-abc",
      OPENAI_BASE_URL: "https://custom.openai.com",
      CURSOR_API_KEY: "cur-xyz",
      KEEP_ME: "yes",
    });
    expect(env.HOME).toBe("/home/user");
    expect(env.KEEP_ME).toBe("yes");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBeUndefined();
  });

  it("preserves HOME and PATH", () => {
    const env = executorEnv({
      HOME: "/custom/home",
      PATH: "/custom/bin",
      USER: "tester",
      SHELL: "/bin/zsh",
    });
    expect(env.HOME).toBe("/custom/home");
    expect(env.PATH).toBe("/custom/bin");
    expect(env.USER).toBe("tester");
    expect(env.SHELL).toBe("/bin/zsh");
  });

  it("handles empty input gracefully", () => {
    const env = executorEnv({});
    expect(env).toEqual({});
  });

  it("handles undefined values in input", () => {
    const env = executorEnv({
      HOME: "/home/user",
      TANYA_X: undefined,
      ANTHROPIC_API_KEY: undefined,
    });
    expect(env.HOME).toBe("/home/user");
    expect(env.TANYA_X).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("executor fake-binary integration", () => {
  it("run() captures exit code and output from a fake CLI binary", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tanya-executor-test-"));
    const fakeBinary = join(tmpDir, "fake-cli.sh");
    writeFileSync(
      fakeBinary,
      `#!/bin/bash
echo '{"type":"thread.started","thread_id":"test-123"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"hello from fake executor"}]}}'
echo '{"type":"result","terminal_reason":"completed"}'
echo "some final text on stdout"
exit 0
`,
    );
    chmodSync(fakeBinary, 0o755);

    const { spawnWithTimeout } = await import("../src/executors/executorUtils");

    const progressLines: string[] = [];
    const result = await spawnWithTimeout(
      fakeBinary,
      ["--json"],
      {
        prompt: "test prompt",
        cwd: tmpDir,
        timeoutMs: 10_000,
        onProgress: (line) => progressLines.push(line),
      },
      { HOME: tmpDir, PATH: process.env.PATH ?? "/usr/bin" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.transcript).toContain("thread.started");
    expect(result.transcript).toContain("hello from fake executor");
    expect(result.transcript).toContain("some final text on stdout");
    expect(result.finalText).toBe("");
    // Progress should have been forwarded for parsable JSON events
    const assistantLines = progressLines.filter((l) => l.includes("hello from fake executor"));
    expect(assistantLines.length).toBeGreaterThan(0);
  });

  it("run() captures non-zero exit code", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tanya-executor-test-"));
    const fakeBinary = join(tmpDir, "fake-fail.sh");
    writeFileSync(
      fakeBinary,
      `#!/bin/bash
echo "something went wrong"
exit 2
`,
    );
    chmodSync(fakeBinary, 0o755);

    const { spawnWithTimeout } = await import("../src/executors/executorUtils");

    const result = await spawnWithTimeout(
      fakeBinary,
      [],
      {
        prompt: "test",
        cwd: tmpDir,
        timeoutMs: 10_000,
      },
      { HOME: tmpDir, PATH: process.env.PATH ?? "/usr/bin" },
    );

    expect(result.exitCode).toBe(2);
    expect(result.transcript).toContain("something went wrong");
  });

  it("run() kills on timeout", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tanya-executor-test-"));
    const fakeBinary = join(tmpDir, "fake-slow.sh");
    writeFileSync(
      fakeBinary,
      `#!/bin/bash
trap 'exit 0' TERM
echo "starting slow work..."
sleep 30
echo "finished"
`,
    );
    chmodSync(fakeBinary, 0o755);

    const { spawnWithTimeout } = await import("../src/executors/executorUtils");

    const result = await spawnWithTimeout(
      fakeBinary,
      [],
      {
        prompt: "test",
        cwd: tmpDir,
        timeoutMs: 1_000,
      },
      { HOME: tmpDir, PATH: process.env.PATH ?? "/usr/bin" },
    );

    // The group kill reaches the whole tree (the foreground `sleep` too), so
    // the trapped-TERM script can even exit 0 — a timed-out run must read as
    // timed out REGARDLESS of exit code/signal. This test caught two real
    // bugs: `child.killed` misuse (SIGKILL escalation never fired) and a
    // leader-only kill leaving grandchildren holding the stdio pipes open.
    expect(result.timedOut).toBe(true);
    expect(result.transcript).toContain("starting slow work");
    expect(result.finalText).toContain("timed out");
  }, 20_000);

  it("transcript is capped at 200KB", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tanya-executor-test-"));
    const fakeBinary = join(tmpDir, "fake-chatty.sh");
    writeFileSync(
      fakeBinary,
      `#!/bin/bash
for i in $(seq 1 5000); do
  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"line number '$i' with some padding to make it longer yes really"}]}}'
done
echo '{"type":"result","terminal_reason":"completed"}'
`,
    );
    chmodSync(fakeBinary, 0o755);

    const { spawnWithTimeout } = await import("../src/executors/executorUtils");

    const result = await spawnWithTimeout(
      fakeBinary,
      [],
      {
        prompt: "test",
        cwd: tmpDir,
        timeoutMs: 15_000,
      },
      { HOME: tmpDir, PATH: process.env.PATH ?? "/usr/bin" },
    );

    expect(result.exitCode).toBe(0);
    // Transcript should be capped to roughly 200KB
    const transcriptBytes = Buffer.byteLength(result.transcript, "utf8");
    expect(transcriptBytes).toBeLessThanOrEqual(210 * 1024); // Allow some slack
    // Should still contain the last line (result event)
    expect(result.transcript).toContain('"type":"result"');
    // But early lines should be truncated
    expect(result.transcript).not.toContain("line number 1");
  });
});

describe("executor auth detection", () => {
  it("detects claude auth expired from transcript", async () => {
    const { isAuthExpiredError } = await import("../src/executors/executorUtils");
    expect(isAuthExpiredError("authentication required", 0, "claude")).toBe(true);
    expect(isAuthExpiredError("not logged in", 0, "claude")).toBe(true);
    expect(isAuthExpiredError("everything ok", 0, "claude")).toBe(false);
  });

  it("detects codex auth expired from transcript", async () => {
    const { isAuthExpiredError } = await import("../src/executors/executorUtils");
    expect(isAuthExpiredError("please run 'codex login'", 0, "codex")).toBe(true);
    expect(isAuthExpiredError("not logged in", 0, "codex")).toBe(true);
    expect(isAuthExpiredError("task completed", 0, "codex")).toBe(false);
  });

  it("detects cursor auth expired from transcript", async () => {
    const { isAuthExpiredError } = await import("../src/executors/executorUtils");
    expect(isAuthExpiredError("Authentication required. Please run 'agent login' first", 0, "cursor")).toBe(true);
    expect(isAuthExpiredError("set CURSOR_API_KEY", 0, "cursor")).toBe(true);
    expect(isAuthExpiredError("task completed", 0, "cursor")).toBe(false);
  });
});
