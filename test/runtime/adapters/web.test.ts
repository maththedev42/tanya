import { describe, expect, it } from "vitest";
import { runBootTest } from "../../../src/runtime";
import { webAdapter } from "../../../src/runtime/adapters/web";
import { makeFakeExec } from "../fakeExec";

const WS = "/ws";
const SHOT_PATH = "/ws/.tanya/runtime/t/first-frame.png";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const VITE_FILES = {
  "/ws/package.json": JSON.stringify({
    name: "webapp",
    version: "1.0.0",
    scripts: { dev: "vite" },
    dependencies: { vite: "5.0.0" },
  }),
  "/ws/node_modules/.package-lock.json": "{}",
};

function bootWeb(exec: ReturnType<typeof makeFakeExec>) {
  return runBootTest({ workspace: WS, platform: "web", exec, adapters: [webAdapter], runId: "t" });
}

describe("web boot adapter", () => {
  it("dev server happy path without Chrome: HTTP gates, screenshot skipped — PASS", async () => {
    const exec = makeFakeExec({
      files: VITE_FILES,
      launchScript: () => ({ log: "  ➜  Local:   http://localhost:5173/\n" }),
      fetch: (url) => (url.includes(":5173") ? { status: 200, body: "<html><body>app</body></html>" } : null),
      respond: (call) => (call.command === "which" ? { exit: 1 } : undefined),
    });
    const verdict = await bootWeb(exec);
    expect(verdict.status).toBe("pass");
    const screenshotCheck = verdict.checks.find((check) => check.description.includes("screenshot"));
    expect(screenshotCheck?.skipped).toBe(true);
    expect(exec.launches[0]?.killed).toBe(true);
  });

  it("uses the URL from the dev-server log, not the injected PORT", async () => {
    const fetched: string[] = [];
    const exec = makeFakeExec({
      files: VITE_FILES,
      launchScript: () => ({ log: "Local: http://localhost:5173/\n" }),
      fetch: (url) => {
        fetched.push(url);
        return { status: 200, body: "<html>x</html>" };
      },
      respond: (call) => (call.command === "which" ? { exit: 1 } : undefined),
    });
    await bootWeb(exec);
    expect(fetched[0]).toContain(":5173");
  });

  it("dev server crash during warmup is a crash FAIL", async () => {
    const exec = makeFakeExec({
      files: VITE_FILES,
      launchScript: () => ({ exitAfterMs: 500, exitCode: 1, log: "Error: Cannot resolve import './App'\n" }),
    });
    const verdict = await bootWeb(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("crash");
  });

  it("a page that only serves errors is an http-down FAIL", async () => {
    const exec = makeFakeExec({
      files: VITE_FILES,
      launchScript: () => ({ log: "Local: http://localhost:5173/\n" }),
      fetch: () => ({ status: 500, body: "Internal Server Error" }),
    });
    const verdict = await bootWeb(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("http-down");
  });

  it("blank first frame is a FAIL with the screenshot as evidence", async () => {
    const exec = makeFakeExec({
      files: { ...VITE_FILES, [CHROME]: "binary", [SHOT_PATH]: "png-bytes" },
      launchScript: () => ({ log: "Local: http://localhost:5173/\n" }),
      fetch: () => ({ status: 200, body: "<html>shell</html>" }),
      blankImage: (path) => path === SHOT_PATH,
    });
    const verdict = await bootWeb(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("blank-first-frame");
    expect(verdict.evidence.some((item) => item.kind === "screenshot" && item.path === SHOT_PATH)).toBe(true);
    expect(exec.launches[0]?.killed).toBe(true);
  });

  it("non-blank first frame with Chrome present is a PASS with screenshot evidence", async () => {
    const exec = makeFakeExec({
      files: { ...VITE_FILES, [CHROME]: "binary", [SHOT_PATH]: "png-bytes" },
      launchScript: () => ({ log: "Local: http://localhost:5173/\n" }),
      fetch: () => ({ status: 200, body: "<html>app</html>" }),
      blankImage: () => false,
    });
    const verdict = await bootWeb(exec);
    expect(verdict.status).toBe("pass");
    expect(verdict.evidence.some((item) => item.kind === "screenshot")).toBe(true);
    const chromeCall = exec.calls.find((call) => call.command === CHROME);
    expect(chromeCall?.args).toContain("--headless=new");
  });

  it("Chrome capture failure does not gate a serving app", async () => {
    const exec = makeFakeExec({
      files: { ...VITE_FILES, [CHROME]: "binary" },
      launchScript: () => ({ log: "Local: http://localhost:5173/\n" }),
      fetch: () => ({ status: 200, body: "<html>app</html>" }),
      respond: (call) => (call.command === CHROME ? { exit: 1, stderr: "chrome crashed" } : undefined),
    });
    const verdict = await bootWeb(exec);
    expect(verdict.status).toBe("pass");
    const screenshotCheck = verdict.checks.find((check) => check.description.includes("screenshot"));
    expect(screenshotCheck?.skipped).toBe(true);
  });

  it("serves a static index.html without any package.json — PASS (landing)", async () => {
    const exec = makeFakeExec({
      files: { "/ws/index.html": "<html><body>landing page</body></html>" },
      fetch: (url) => (url.includes("127.0.0.1") ? { status: 200, body: "<html>landing</html>" } : null),
      respond: (call) => (call.command === "which" ? { exit: 1 } : undefined),
    });
    const verdict = await runBootTest({ workspace: WS, platform: "landing", exec, adapters: [webAdapter], runId: "t" });
    expect(verdict.status).toBe("pass");
    expect(verdict.platform).toBe("web");
    expect(exec.launches).toHaveLength(0);
  });
});
