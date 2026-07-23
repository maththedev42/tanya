import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../index";

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

describe("/test-app command", () => {
  it("boots a tiny CLI fixture and prints the runtime report", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-test-app-command-"));
    mkdirSync(join(workspace, "bin"), { recursive: true });
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ name: "fixture-cli", version: "1.0.0", bin: { hello: "bin/hello.js" } }),
    );
    writeFileSync(join(workspace, "bin", "hello.js"), "console.log('usage: hello');\n");
    const output = new MemoryStream();

    await expect(
      runCommand("/test-app script", {
        cwd: workspace,
        output: output as unknown as NodeJS.WritableStream,
        sink: () => {},
      }),
    ).resolves.toBe(true);

    const text = output.chunks.join("");
    expect(text).toContain("## Runtime boot test — script");
    expect(text).toContain("TANYA RESULT: PASSED");
    expect(text).toContain("Tanya manifest:");
  }, 30_000);

  it("prints a usage message for an unknown platform", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-test-app-command-usage-"));
    const output = new MemoryStream();
    await runCommand("/test-app vr-headset", {
      cwd: workspace,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
    });
    expect(output.chunks.join("")).toContain("Unknown platform");
  });
});
