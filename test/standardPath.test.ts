import { afterEach, describe, expect, it } from "vitest";
import { processEnvWithStandardPath } from "../src/tools/fsTools";

const original = process.env.PATH;
afterEach(() => {
  process.env.PATH = original;
});

describe("processEnvWithStandardPath", () => {
  it("appends standard bin dirs when the inherited PATH is deficient (no /usr/bin)", () => {
    process.env.PATH = "/Users/x/.local/share/mise/shims";
    const parts = (processEnvWithStandardPath().PATH ?? "").split(":");
    for (const dir of ["/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/sbin", "/sbin"]) {
      expect(parts).toContain(dir);
    }
  });

  it("keeps the inherited PATH first (a deliberate toolchain still wins)", () => {
    process.env.PATH = "/Users/x/.local/share/mise/shims:/custom/bin";
    const parts = (processEnvWithStandardPath().PATH ?? "").split(":");
    expect(parts[0]).toBe("/Users/x/.local/share/mise/shims");
    expect(parts[1]).toBe("/custom/bin");
  });

  it("does not duplicate dirs already present", () => {
    process.env.PATH = "/usr/bin:/bin:/opt/homebrew/bin";
    const parts = (processEnvWithStandardPath().PATH ?? "").split(":");
    expect(parts.filter((p) => p === "/usr/bin")).toHaveLength(1);
    expect(parts.filter((p) => p === "/opt/homebrew/bin")).toHaveLength(1);
  });

  it("works when PATH is unset", () => {
    delete process.env.PATH;
    const parts = (processEnvWithStandardPath().PATH ?? "").split(":");
    expect(parts).toContain("/usr/bin");
  });
});
