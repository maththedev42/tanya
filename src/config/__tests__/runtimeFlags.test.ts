import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RUNTIME_FLAGS,
  clampedIntFlag,
  offFlag,
  offablePositiveIntFlag,
  onFlag,
  optionalPositiveIntFlag,
  positiveIntFlag,
  ratioFlag,
  renderEnvExample,
  stringFlag,
} from "../runtimeFlags";

const KEY = "TANYA_TEST_FLAG_XYZ";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runtimeFlags — accessor primitives", () => {
  it("onFlag: default OFF, enabled by 1|true|yes|on only", () => {
    expect(onFlag(KEY)).toBe(false);
    for (const v of ["1", "true", "YES", "on"]) {
      vi.stubEnv(KEY, v);
      expect(onFlag(KEY)).toBe(true);
    }
    for (const v of ["0", "banana", "off", ""]) {
      vi.stubEnv(KEY, v);
      expect(onFlag(KEY)).toBe(false);
    }
  });

  it("offFlag: default ON, disabled by 0|false|off|no only", () => {
    expect(offFlag(KEY)).toBe(true);
    for (const v of ["0", "false", "OFF", "no"]) {
      vi.stubEnv(KEY, v);
      expect(offFlag(KEY)).toBe(false);
    }
    for (const v of ["1", "banana", ""]) {
      vi.stubEnv(KEY, v);
      expect(offFlag(KEY)).toBe(true);
    }
  });

  it("positiveIntFlag: floors positives, falls back otherwise", () => {
    expect(positiveIntFlag(KEY, 7)).toBe(7);
    vi.stubEnv(KEY, "12.9");
    expect(positiveIntFlag(KEY, 7)).toBe(12);
    for (const v of ["-3", "0", "abc", ""]) {
      vi.stubEnv(KEY, v);
      expect(positiveIntFlag(KEY, 7)).toBe(7);
    }
  });

  it("optionalPositiveIntFlag: undefined when unset or invalid", () => {
    expect(optionalPositiveIntFlag(KEY)).toBeUndefined();
    vi.stubEnv(KEY, "40");
    expect(optionalPositiveIntFlag(KEY)).toBe(40);
    for (const v of ["", "0", "-1", "x"]) {
      vi.stubEnv(KEY, v);
      expect(optionalPositiveIntFlag(KEY)).toBeUndefined();
    }
  });

  it("offablePositiveIntFlag: off spellings mean 0, invalid means fallback", () => {
    expect(offablePositiveIntFlag(KEY, 100)).toBe(100);
    for (const v of ["0", "off", "false", "no"]) {
      vi.stubEnv(KEY, v);
      expect(offablePositiveIntFlag(KEY, 100)).toBe(0);
    }
    vi.stubEnv(KEY, "250000");
    expect(offablePositiveIntFlag(KEY, 100)).toBe(250000);
    vi.stubEnv(KEY, "junk");
    expect(offablePositiveIntFlag(KEY, 100)).toBe(100);
  });

  it("ratioFlag: accepts (0,1] only", () => {
    expect(ratioFlag(KEY, 0.25)).toBe(0.25);
    vi.stubEnv(KEY, "0.8");
    expect(ratioFlag(KEY, 0.25)).toBe(0.8);
    for (const v of ["0", "1.5", "-1", "x"]) {
      vi.stubEnv(KEY, v);
      expect(ratioFlag(KEY, 0.25)).toBe(0.25);
    }
    vi.stubEnv(KEY, "1");
    expect(ratioFlag(KEY, 0.25)).toBe(1);
  });

  it("clampedIntFlag: applies the min clamp to values and fallback alike", () => {
    expect(clampedIntFlag(KEY, 5, 1)).toBe(5);
    vi.stubEnv(KEY, "0");
    expect(clampedIntFlag(KEY, 5, 1)).toBe(1);
    vi.stubEnv(KEY, "9.7");
    expect(clampedIntFlag(KEY, 5, 1)).toBe(9);
    vi.stubEnv(KEY, "junk");
    expect(clampedIntFlag(KEY, 5, 1)).toBe(5);
  });

  it("stringFlag trims and defaults to empty", () => {
    expect(stringFlag(KEY)).toBe("");
    vi.stubEnv(KEY, "  value  ");
    expect(stringFlag(KEY)).toBe("value");
  });
});

describe("runtimeFlags — registry", () => {
  it("has unique TANYA_-prefixed names", () => {
    const names = RUNTIME_FLAGS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^TANYA_[A-Z0-9_]+$/);
  });

  it("every flag has a description and a section", () => {
    for (const flag of RUNTIME_FLAGS) {
      expect(flag.description.length, flag.name).toBeGreaterThan(10);
      expect(flag.section.length, flag.name).toBeGreaterThan(0);
    }
  });

  it(".env.example is generated from the registry (run scripts/gen-env-example.ts after editing flags)", () => {
    const onDisk = readFileSync(join(__dirname, "..", "..", "..", ".env.example"), "utf8");
    expect(onDisk).toBe(renderEnvExample());
  });

  it("internal flags stay out of .env.example", () => {
    const rendered = renderEnvExample();
    for (const flag of RUNTIME_FLAGS.filter((f) => f.internal)) {
      expect(rendered).not.toContain(flag.name);
    }
    expect(rendered).toContain("TANYA_MAX_STALL_TOKENS");
    expect(rendered).toContain("TANYA_DRIFT_GUARD");
  });
});
