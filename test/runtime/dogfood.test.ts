import { describe, expect, it } from "vitest";
import { runBootTest } from "../../src/runtime";

// Dogfood: boot-test Tanya herself (script platform, bin = dist/cli.js).
// Opt-in because it needs a built dist/: TANYA_RUNTIME_E2E=1 npm test
const enabled = process.env.TANYA_RUNTIME_E2E === "1";

describe.skipIf(!enabled)("runtime dogfood — tanya tests tanya", () => {
  it("tanya's own CLI passes the Tier-0 boot test", async () => {
    const verdict = await runBootTest({ workspace: process.cwd(), platform: "script" });
    expect(verdict.status).toBe("pass");
    expect(verdict.reason).toContain("exit 0");
  }, 120_000);
});
