import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// End-to-end through the real CLI with a real (tiny, node-only) server boot.

function writeServerFixture(script: string): string {
  const root = mkdtempSync(join(tmpdir(), "tanya-test-app-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture-server", version: "1.0.0", scripts: { start: "node server.js" } }),
  );
  writeFileSync(join(root, "server.js"), script);
  return root;
}

function runTestApp(cwd: string): { exitCode: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "test-app", "--platform", "backend", "--cwd", cwd, "--warmup", "800", "--json"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    return { exitCode: 0, output };
  } catch (err) {
    const failure = err as { status?: number; stdout?: string };
    return { exitCode: failure.status ?? -1, output: failure.stdout ?? "" };
  }
}

function finalEvent(output: string): { message: string; manifest: { blockers: string[] } } {
  const lines = output.trim().split(/\r?\n/);
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { type?: string; message?: string; manifest?: { blockers: string[] } };
      if (event.type === "final" && event.message && event.manifest) {
        return { message: event.message, manifest: event.manifest };
      }
    } catch {
      continue;
    }
  }
  throw new Error(`no final event in output:\n${output}`);
}

describe("tanya test-app CLI", () => {
  it("passes a booting server: exit 0, TANYA RESULT: PASSED, empty blockers", () => {
    const cwd = writeServerFixture(
      "const http = require('node:http');\n" +
        "const server = http.createServer((q, r) => r.end('ok'));\n" +
        "server.listen(process.env.PORT || 0, () => console.log('listening on http://127.0.0.1:' + server.address().port));\n",
    );
    const { exitCode, output } = runTestApp(cwd);
    expect(exitCode).toBe(0);
    const final = finalEvent(output);
    expect(final.message).toContain("TANYA RESULT: PASSED");
    expect(final.manifest.blockers).toEqual([]);
  }, 60_000);

  it("fails a crashing server: exit 1, TANYA RESULT: FAIL, blocker with evidence", () => {
    const cwd = writeServerFixture("console.error('boom: missing env'); process.exit(3);\n");
    const { exitCode, output } = runTestApp(cwd);
    expect(exitCode).toBe(1);
    const final = finalEvent(output);
    expect(final.message).toContain("TANYA RESULT: FAIL");
    expect(final.manifest.blockers.length).toBeGreaterThan(0);
    expect(final.manifest.blockers[0]).toContain("runtime boot failed");
    expect(final.message).toContain("crash");
  }, 60_000);

  it("reports a usage error for an unknown platform with exit 1", () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-test-app-usage-"));
    try {
      execFileSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "test-app", "--platform", "vr-headset", "--cwd", cwd, "--json"],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect.unreachable("expected a non-zero exit");
    } catch (err) {
      const failure = err as { status?: number; stdout?: string };
      expect(failure.status).toBe(1);
      expect(failure.stdout).toContain("Unknown platform");
    }
  }, 60_000);
});
