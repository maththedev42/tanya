import { describe, expect, it } from "vitest";
import {
  STUCK_ERROR_FOLD_STOP_AFTER,
  STUCK_STOP_AFTER,
  STUCK_WARN_AFTER,
  StuckGuard,
  canonicalArgsHash,
  errorSignature,
} from "../stuckGuard";

describe("stuckGuard — fingerprints", () => {
  it("canonicalArgsHash is key-order independent", () => {
    expect(canonicalArgsHash({ a: 1, b: [2, 3] })).toBe(canonicalArgsHash({ b: [2, 3], a: 1 }));
    expect(canonicalArgsHash({ a: 1 })).not.toBe(canonicalArgsHash({ a: 2 }));
  });

  it("errorSignature folds numbers, hex ids, and paths", () => {
    expect(errorSignature("error at /tmp/x1/file.ts:12: attempt 3 failed (0xdeadbeef)"))
      .toBe(errorSignature("error at /var/y9/other.ts:99: attempt 7 failed (0xcafebabe)"));
    expect(errorSignature("cat: illegal option -- A")).not.toBe(errorSignature("permission denied"));
  });
});

describe("stuckGuard — escalation", () => {
  it("warns after 3 identical failures, stops after 5", () => {
    const guard = new StuckGuard();
    const step = () => guard.observeFailure("run_shell", { script: "npm test" }, "1 failing: math.test.ts");
    expect(step().action).toBe("none");
    expect(step().action).toBe("none");
    const warn = step();
    expect(warn.action).toBe("warn");
    expect(warn.repeatedWarn).toBe(false);
    const warnAgain = step();
    expect(warnAgain.action).toBe("warn");
    expect(warnAgain.repeatedWarn).toBe(true); // nudge only injected once
    expect(step().action).toBe("stop");
    expect(STUCK_WARN_AFTER).toBe(3);
    expect(STUCK_STOP_AFTER).toBe(5);
  });

  it("folds cosmetically different commands with the same error signature", () => {
    const guard = new StuckGuard();
    const variants = [
      { script: "sed -n 1,10p file.txt | cat -A" },
      { script: "cat -A file.txt" },
      { script: "cat -A ./file.txt # again" },
      { script: "bash -c 'cat -A file.txt'" },
      { script: "cat -A file.txt | head" },
      { script: "cat -A 'file.txt'" },
    ];
    const actions = variants.map((input) =>
      guard.observeFailure("run_shell", input, "cat: illegal option -- A\nusage: cat [-belnstuv]").action,
    );
    // Different args → exact streaks never trip, but the shared error
    // signature folds them: warn at 4, stop at 6.
    expect(actions[2]).toBe("none");
    expect(actions[3]).toBe("warn");
    expect(actions[STUCK_ERROR_FOLD_STOP_AFTER - 1]).toBe("stop");
  });

  it("detects A/B alternation loops", () => {
    const guard = new StuckGuard();
    let last = "none";
    for (let index = 0; index < 6; index += 1) {
      const input = index % 2 === 0 ? { script: "step A" } : { script: "step B" };
      const error = index % 2 === 0 ? "error alpha" : "error beta";
      last = guard.observeFailure("run_shell", input, error).action;
    }
    expect(last).toBe("stop");
  });

  it("a mutation resets every streak", () => {
    const guard = new StuckGuard();
    guard.observeFailure("run_shell", { script: "x" }, "same err");
    guard.observeFailure("run_shell", { script: "x" }, "same err");
    guard.reset();
    expect(guard.observeFailure("run_shell", { script: "x" }, "same err").action).toBe("none");
  });

  it("distinct failures never escalate", () => {
    const guard = new StuckGuard();
    for (let index = 0; index < 10; index += 1) {
      const observation = guard.observeFailure("run_shell", { script: `cmd-${index}` }, `unique error kind ${String.fromCharCode(65 + index)}${"!".repeat(index)}`);
      expect(observation.action).toBe("none");
    }
  });
});
