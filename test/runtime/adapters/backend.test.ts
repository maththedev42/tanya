import { describe, expect, it } from "vitest";
import { runBootTest } from "../../../src/runtime";
import { backendAdapter } from "../../../src/runtime/adapters/backend";
import { makeFakeExec } from "../fakeExec";

const WS = "/ws";

const GO_FILES = {
  "/ws/go.mod": "module example.com/svc\n",
  "/ws/cmd/server/main.go": "package main\nfunc main() {}\n",
};

const NODE_FILES = {
  "/ws/package.json": JSON.stringify({
    name: "svc",
    version: "1.0.0",
    scripts: { start: "node server.js" },
    dependencies: { express: "4.0.0" },
  }),
  "/ws/server.js": "// server",
  "/ws/node_modules/.package-lock.json": "{}",
};

function bootBackend(exec: ReturnType<typeof makeFakeExec>) {
  return runBootTest({ workspace: WS, platform: "backend", exec, adapters: [backendAdapter], runId: "t" });
}

describe("backend boot adapter", () => {
  it("go server: builds, launches, probes HTTP, and tears down — PASS", async () => {
    const exec = makeFakeExec({
      files: GO_FILES,
      launchScript: () => ({ log: "listening on http://localhost:42000\n" }),
      fetch: (url) => (url.includes(":42000") ? { status: 200, body: "ok" } : null),
    });
    const verdict = await bootBackend(exec);
    expect(verdict.status).toBe("pass");
    expect(exec.calls.map((call) => call.command)).toContain("go");
    const build = exec.calls.find((call) => call.command === "go" && call.args[0] === "build");
    expect(build?.args).toContain("./cmd/server");
    expect(exec.launches[0]?.killed).toBe(true);
    expect(verdict.checks.filter((check) => check.passed)).toHaveLength(4);
  });

  it("missing go toolchain is a SKIP, never a FAIL", async () => {
    const exec = makeFakeExec({
      files: GO_FILES,
      respond: (call) => (call.command === "go" && call.args[0] === "version" ? { binaryMissing: true, exit: 1 } : undefined),
    });
    const verdict = await bootBackend(exec);
    expect(verdict.status).toBe("skipped");
    expect(verdict.reason).toContain("go toolchain");
  });

  it("go build failure is a provision FAIL with log evidence", async () => {
    const exec = makeFakeExec({
      files: GO_FILES,
      respond: (call) =>
        call.command === "go" && call.args[0] === "build"
          ? { exit: 1, stderr: "cmd/server/main.go:3: undefined: missingSymbol" }
          : undefined,
    });
    const verdict = await bootBackend(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("provision-failed");
    expect(verdict.evidence.some((item) => item.excerpt?.includes("missingSymbol"))).toBe(true);
  });

  it("node server that dies during warmup is a crash FAIL and still tears down", async () => {
    const exec = makeFakeExec({
      files: NODE_FILES,
      launchScript: () => ({ exitAfterMs: 1_000, exitCode: 1, log: "Error: Cannot find module 'left-pad'\n" }),
    });
    const verdict = await bootBackend(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("crash");
    expect(verdict.reason).toContain("warmup");
    expect(exec.launches[0]?.killCalls).toBe(1);
    expect(exec.launches[0]?.options.command).toBe("npm");
    expect(exec.launches[0]?.options.env?.PORT).toMatch(/^\d+$/);
  });

  it("alive server that never answers HTTP is an http-down FAIL", async () => {
    const exec = makeFakeExec({
      files: NODE_FILES,
      launchScript: () => ({ log: "started\n" }),
      fetch: () => null,
    });
    const verdict = await bootBackend(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("http-down");
    expect(exec.launches[0]?.killed).toBe(true);
  });

  it("runs npm install when node_modules is missing", async () => {
    const files = { ...NODE_FILES };
    delete (files as Record<string, string>)["/ws/node_modules/.package-lock.json"];
    const exec = makeFakeExec({
      files,
      launchScript: () => ({ log: "listening on port 42000\n" }),
      fetch: () => ({ status: 200, body: "ok" }),
    });
    const verdict = await bootBackend(exec);
    expect(verdict.status).toBe("pass");
    expect(exec.calls.some((call) => call.command === "npm" && call.args[0] === "install")).toBe(true);
  });

  it("finds the port in structured JSON logs (slog/zap style)", async () => {
    const fetched: string[] = [];
    const exec = makeFakeExec({
      files: NODE_FILES,
      launchScript: () => ({
        log: '{"time":"2026-06-11T00:08:02-03:00","level":"INFO","msg":"starting server","port":"8000"}\n',
      }),
      fetch: (url) => {
        fetched.push(url);
        return { status: 200, body: "ok" };
      },
    });
    const verdict = await bootBackend(exec);
    expect(verdict.status).toBe("pass");
    expect(fetched[0]).toContain(":8000");
  });

  it("prefers the URL printed in the log over the injected PORT", async () => {
    const fetched: string[] = [];
    const exec = makeFakeExec({
      files: NODE_FILES,
      launchScript: () => ({ log: "ready on http://127.0.0.1:5555\n" }),
      fetch: (url) => {
        fetched.push(url);
        return { status: 200, body: "ok" };
      },
    });
    const verdict = await bootBackend(exec);
    expect(verdict.status).toBe("pass");
    expect(fetched[0]).toContain(":5555");
  });

  it("keep-alive leaves the server running", async () => {
    const exec = makeFakeExec({
      files: NODE_FILES,
      launchScript: () => ({ log: "listening on port 42000\n" }),
      fetch: () => ({ status: 200, body: "ok" }),
    });
    const verdict = await runBootTest({
      workspace: WS,
      platform: "backend",
      exec,
      adapters: [backendAdapter],
      keepAlive: true,
    });
    expect(verdict.status).toBe("pass");
    expect(exec.launches[0]?.killCalls).toBe(0);
  });
});
