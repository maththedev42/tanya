import { describe, expect, it } from "vitest";
import { runBootTest } from "../../../src/runtime";
import { scriptAdapter } from "../../../src/runtime/adapters/script";
import { makeFakeExec, type RunCall } from "../fakeExec";

const WS = "/ws";

const CLI_FILES = {
  "/ws/package.json": JSON.stringify({
    name: "@scope/tool",
    version: "1.0.0",
    bin: { tool: "dist/cli.js" },
    scripts: { build: "tsup" },
  }),
  "/ws/dist/cli.js": "#!/usr/bin/env node\n",
  "/ws/node_modules/.package-lock.json": "{}",
};

function bootScript(exec: ReturnType<typeof makeFakeExec>) {
  return runBootTest({ workspace: WS, platform: "script", exec, adapters: [scriptAdapter], runId: "t" });
}

const isCliRun = (call: RunCall) => call.command === "node" && call.args[0] === "/ws/dist/cli.js";

describe("script boot adapter", () => {
  it("passes when --help exits 0 with output", async () => {
    const exec = makeFakeExec({
      files: CLI_FILES,
      respond: (call) => (isCliRun(call) ? { exit: 0, stdout: "usage: tool [command]" } : undefined),
    });
    const verdict = await bootScript(exec);
    expect(verdict.status).toBe("pass");
    expect(exec.calls.filter(isCliRun)).toHaveLength(1);
    expect(verdict.checks.filter((check) => check.passed)).toHaveLength(4);
  });

  it("falls back to --version when --help fails", async () => {
    const exec = makeFakeExec({
      files: CLI_FILES,
      respond: (call) => {
        if (!isCliRun(call)) return undefined;
        return call.args.includes("--help") ? { exit: 2, stderr: "unknown flag" } : { exit: 0, stdout: "1.0.0" };
      },
    });
    const verdict = await bootScript(exec);
    expect(verdict.status).toBe("pass");
    expect(exec.calls.filter(isCliRun)).toHaveLength(2);
  });

  it("fails with nonzero-exit when both probes fail, with output evidence", async () => {
    const exec = makeFakeExec({
      files: CLI_FILES,
      respond: (call) =>
        isCliRun(call) ? { exit: 1, stderr: "Error: Cannot find module 'commander'\n    at require" } : undefined,
    });
    const verdict = await bootScript(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("nonzero-exit");
    expect(verdict.reason).toContain("Cannot find module");
  });

  it("exit 0 with empty output is not a booted surface", async () => {
    const exec = makeFakeExec({
      files: CLI_FILES,
      respond: (call) => (isCliRun(call) ? { exit: 0, stdout: "" } : undefined),
    });
    const verdict = await bootScript(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.reason).toContain("no output");
  });

  it("builds first when the bin target is missing", async () => {
    const files = { ...CLI_FILES };
    delete (files as Record<string, string>)["/ws/dist/cli.js"];
    const exec = makeFakeExec({
      files,
      respond: (call) => {
        if (call.command === "npm" && call.args[1] === "build") {
          // The build produces the bin target.
          void exec.writeFile("/ws/dist/cli.js", "built");
          return { exit: 0 };
        }
        if (isCliRun(call)) return { exit: 0, stdout: "usage" };
        return undefined;
      },
    });
    const verdict = await bootScript(exec);
    expect(verdict.status).toBe("pass");
    expect(exec.calls.some((call) => call.command === "npm" && call.args[1] === "build")).toBe(true);
  });

  it("fails provision when the bin target never materializes", async () => {
    const exec = makeFakeExec({
      files: {
        "/ws/package.json": JSON.stringify({ name: "tool", version: "1.0.0", bin: { tool: "dist/cli.js" } }),
        "/ws/node_modules/.package-lock.json": "{}",
      },
    });
    const verdict = await bootScript(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("provision-failed");
    expect(verdict.reason).toContain("dist/cli.js");
  });

  it("a hung CLI maps to a timeout FAIL", async () => {
    const exec = makeFakeExec({
      files: CLI_FILES,
      respond: (call) => (isCliRun(call) ? { exit: 1, timedOut: true } : undefined),
    });
    const verdict = await bootScript(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("timeout");
  });
});
