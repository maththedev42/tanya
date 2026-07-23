import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ephemeralPort, realRuntimeExec, serveStaticDir, waitForHttp } from "../../src/runtime/process";

const realClockExec = () => {
  const exec = realRuntimeExec();
  return { fetchUrl: exec.fetchUrl, sleep: exec.sleep, now: exec.now };
};

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("runtime process utilities", () => {
  it("launches a long-running process, captures logs, and reports liveness", async () => {
    const exec = realRuntimeExec();
    const handle = await exec.launch({
      command: process.execPath,
      args: ["-e", "console.log('booted'); setInterval(() => {}, 1000);"],
      cwd: process.cwd(),
    });
    try {
      expect(handle.pid).toBeGreaterThan(0);
      await waitFor(() => handle.logTail().includes("booted"));
      expect(handle.alive()).toBe(true);
      expect(handle.logTail()).toContain("booted");
    } finally {
      await handle.killTree();
    }
    expect(handle.alive()).toBe(false);
  });

  it("killTree kills grandchildren (the whole process group)", async () => {
    const exec = realRuntimeExec();
    const script = "const c = require('child_process').spawn('sleep', ['30']); console.log('CHILD=' + c.pid); setInterval(() => {}, 1000);";
    const handle = await exec.launch({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
    });
    await waitFor(() => /CHILD=\d+/.test(handle.logTail()));
    const childPid = Number(/CHILD=(\d+)/.exec(handle.logTail())?.[1]);
    expect(childPid).toBeGreaterThan(0);
    expect(() => process.kill(childPid, 0)).not.toThrow();

    await handle.killTree();
    await waitFor(() => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(handle.alive()).toBe(false);
  });

  it("surfaces a missing binary as a dead launch with the error in the log", async () => {
    const exec = realRuntimeExec();
    const handle = await exec.launch({
      command: "/nonexistent/binary-for-tanya-test",
      args: [],
      cwd: process.cwd(),
    });
    await waitFor(() => !handle.alive());
    expect(handle.alive()).toBe(false);
    expect(handle.logTail()).toContain("[launch error]");
  });

  it("waitForHttp reports up for any status below 500", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(404);
      response.end("nope");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const outcome = await waitForHttp(realClockExec(), `http://127.0.0.1:${port}/`, { totalMs: 2_000 });
      expect(outcome.up).toBe(true);
      expect(outcome.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("waitForHttp reports down on connection refused", async () => {
    const port = await ephemeralPort();
    const outcome = await waitForHttp(realClockExec(), `http://127.0.0.1:${port}/`, {
      totalMs: 600,
      intervalMs: 200,
    });
    expect(outcome.up).toBe(false);
    expect(outcome.attempts).toBeGreaterThan(0);
  });

  it("an awaited sleep keeps an otherwise-idle process alive (no unref'd timer)", () => {
    // Regression: with an unref'd sleep timer, a boot test whose app is not a
    // child process (iOS simctl) exited 0 mid-warmup with no verdict.
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const script =
      "const { realRuntimeExec } = require('./src/runtime/process');" +
      "(async () => { await realRuntimeExec().sleep(300); console.log('SLEPT'); })();";
    const output = execFileSync(process.execPath, ["--import", "tsx", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(output).toContain("SLEPT");
  }, 30_000);

  it("serveStaticDir serves index.html and 404s missing paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tanya-static-"));
    writeFileSync(join(dir, "index.html"), "<html><body>landing</body></html>");
    const server = await serveStaticDir(dir);
    try {
      const home = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(home.status).toBe(200);
      expect(await home.text()).toContain("landing");
      const missing = await fetch(`http://127.0.0.1:${server.port}/nope.html`);
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
