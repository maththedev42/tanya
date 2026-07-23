import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";

import { bsdFlagGuidance, runShellTool, runCommandTool, getProgressThrottleMs, isShellParseError, keyErrorLinesBlock, literalPipeHint, pipedSearchNoMatchSummary } from "../fsTools";
import type { ToolProgressEvent } from "../types";

// 500ms throttle = small enough that the streaming test sees "first" well
// before its 2.6s deadline even under load, big enough that the throttling
// test still batches the "a"+"b" (100ms apart) emits into one "ab" chunk.
beforeAll(() => {
  process.env.TANYA_PROGRESS_THROTTLE_MS = "500";
  if (getProgressThrottleMs() !== 500) {
    throw new Error(`expected getProgressThrottleMs()=500, got ${getProgressThrottleMs()}`);
  }
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return predicate();
}

describe("run_shell streaming", () => {
  it("emits stdout progress before a long-running shell command completes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-progress-"));
    const events: ToolProgressEvent[] = [];

    const resultPromise = runShellTool.run(
      { script: "printf first; sleep 3; printf second", timeoutMs: 6_000 },
      { workspace, onProgress: (event) => { events.push(event); } },
    );

    await expect(waitFor(() => events.some((event) => event.chunk.includes("first")), 2_600)).resolves.toBe(true);
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(result.output).toBe("firstsecond");
    expect(events.some((event) => event.stream === "stdout" && event.chunk.includes("first"))).toBe(true);
  });

  it("throttles stdout progress and flushes buffered output on completion", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-throttle-"));
    const events: ToolProgressEvent[] = [];

    const result = await runShellTool.run(
      { script: "printf a; sleep 0.1; printf b; sleep 2.2; printf c", timeoutMs: 6_000 },
      { workspace, onProgress: (event) => { events.push(event); } },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toBe("abc");
    expect(events.map((event) => event.chunk)).toEqual(["ab", "c"]);
    expect(events.every((event) => event.stream === "stdout")).toBe(true);
  });

  it("cancels a long-running shell command and returns partial output quickly", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-cancel-"));
    const controller = new AbortController();

    const resultPromise = runShellTool.run(
      { script: "printf start; touch .tanya-cancel-started; sleep 10; printf never", timeoutMs: 20_000 },
      { workspace, signal: controller.signal },
    );

    await expect(waitFor(() => existsSync(join(workspace, ".tanya-cancel-started")), 2_000)).resolves.toBe(true);
    await wait(25);
    const cancelledAt = Date.now();
    controller.abort();
    const result = await resultPromise;

    expect(Date.now() - cancelledAt).toBeLessThan(700);
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.partial_output).toBe("start");
    expect(result.output).toEqual({ cancelled: true, partial_output: "start" });
  });

  it("marks rejected destructive cleanup as a shell safety block", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-safety-"));

    const result = await runShellTool.run(
      { script: "rm -rf .mvp10", timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(false);
    expect(result.output).toEqual(expect.objectContaining({ reason: "shell_safety_block" }));
  });
});

describe("run_shell search exit semantics", () => {
  it("treats a bare no-match grep as an answer, not a failure", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-grep-"));
    writeFileSync(join(workspace, "code.go"), "package main\n", "utf8");

    const result = await runShellTool.run(
      { script: 'grep -rn "func fromAddress|func FromAddress" .', timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toBe("No matches found.");
    expect(result.summary).toContain("no matches");
  });

  it("accepts one leading cd hop before the search", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-grep-cd-"));
    mkdirSync(join(workspace, "sub"));
    writeFileSync(join(workspace, "sub", "code.go"), "package main\n", "utf8");

    const result = await runShellTool.run(
      { script: 'cd sub && grep -rn "nothing_to_see_here_xyz" .', timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toBe("No matches found.");
  });

  it("treats a no-match grep with a trailing 2>&1 redirect as an answer (the stalled shape)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-grep-redir-"));
    mkdirSync(join(workspace, "pkg"));
    writeFileSync(join(workspace, "pkg", "code.go"), "package main\n", "utf8");

    // The exact shape that stalled a run: leading cd hop, --include, and 2>&1.
    const result = await runShellTool.run(
      { script: 'cd pkg && grep -rn "AppLaunchStep" . --include="*.go" 2>&1', timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toBe("No matches found.");
    expect(result.summary).toContain("no matches");
  });

  it("treats a no-match grep with 2>/dev/null and combined >/dev/null 2>&1 as answers", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-grep-devnull-"));
    writeFileSync(join(workspace, "code.go"), "package main\n", "utf8");

    for (const redirect of ["2>/dev/null", ">/dev/null 2>&1", "2> /dev/null"]) {
      const result = await runShellTool.run(
        { script: `grep -rn "nothing_to_see_here_xyz" . ${redirect}`, timeoutMs: 6_000 },
        { workspace },
      );
      expect(result.ok, redirect).toBe(true);
    }
  });

  it("keeps a real grep error (exit 2) a failure even with 2>&1", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-grep-err2-"));

    const result = await runShellTool.run(
      { script: "grep pattern ./definitely-missing-file.txt 2>&1", timeoutMs: 6_000 },
      { workspace },
    );

    // Exit 2 (not 1) — a genuine error, never forgiven regardless of redirect.
    expect(result.ok).toBe(false);
  });

  it("keeps a real grep error (exit 2, stderr) as a failure", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-grep-err-"));

    const result = await runShellTool.run(
      { script: "grep pattern ./definitely-missing-file.txt", timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(false);
  });

  it("does not blanket-forgive exit 1 from non-search commands", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-false-"));

    const result = await runShellTool.run(
      { script: "false", timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(false);
  });

  it("keeps real exit semantics for pipelines involving grep", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-grep-pipe-"));
    writeFileSync(join(workspace, "code.go"), "package main\n", "utf8");

    const result = await runShellTool.run(
      { script: 'grep -rn "nothing_to_see_here_xyz" . ; exit 1', timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(false);
  });
});

describe("run_shell parse errors (command never executed)", () => {
  it("labels a malformed command (unmatched backtick) as a parse error, not just exit 1", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-parse-"));

    // The exact shape that stalled a run: an unescaped/unmatched backtick inside
    // the grep pattern — zsh rejects it as `unmatched "` and never runs it.
    const result = await runShellTool.run(
      { script: 'grep -rn "AppLaunchStep" . --include="*.go" | grep -v "struct|`json" | head -30', timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/parse error/i);
    expect(result.summary).toMatch(/NOT executed/);
  });

  it("does not mislabel an ordinary non-zero exit as a parse error", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-plainfail-"));

    const result = await runShellTool.run(
      { script: "false", timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(false);
    expect(result.summary).not.toMatch(/parse error/i);
  });

  it("isShellParseError matches shell-prefixed parse errors but not program output", () => {
    expect(isShellParseError('zsh:1: unmatched "')).toBe(true);
    expect(isShellParseError("bash: -c: line 1: unexpected EOF while looking for matching `\"'")).toBe(true);
    expect(isShellParseError("bash: -c: line 1: syntax error near unexpected token `|'")).toBe(true);
    // A compiler that prints "syntax error" in its own output is not a shell
    // parse error (no leading shell prefix).
    expect(isShellParseError("main.go:5:1: syntax error: unexpected }")).toBe(false);
    expect(isShellParseError("")).toBe(false);
  });
});

describe("literal-pipe grep hint (plain grep treats | as a literal character)", () => {
  it("literalPipeHint fires for plain grep/zgrep with an unescaped | and no -E/-P/-F flag", () => {
    expect(literalPipeHint("grep", '-rn "a|b" .')).toMatch(/literal pipe/i);
    expect(literalPipeHint("zgrep", '"a|b" file.gz')).toMatch(/literal pipe/i);
  });

  it("literalPipeHint does not fire when an alternation/fixed flag is present", () => {
    expect(literalPipeHint("grep", '-rnE "a|b" .')).toBeNull();
    expect(literalPipeHint("grep", '--extended-regexp "a|b" .')).toBeNull();
    expect(literalPipeHint("grep", '-P "a|b" .')).toBeNull();
    expect(literalPipeHint("grep", '-F "a|b" .')).toBeNull();
  });

  it("literalPipeHint does not fire for egrep/rg/ag (extended by default) or fgrep (fixed by default)", () => {
    expect(literalPipeHint("egrep", '"a|b" .')).toBeNull();
    expect(literalPipeHint("rg", '"a|b" .')).toBeNull();
    expect(literalPipeHint("ag", '"a|b" .')).toBeNull();
    expect(literalPipeHint("fgrep", '"a|b" .')).toBeNull();
  });

  it("literalPipeHint does not fire without a pipe, or when the pipe is GNU-BRE-escaped", () => {
    expect(literalPipeHint("grep", '-rn "plain" .')).toBeNull();
    expect(literalPipeHint("grep", '-rn "a\\|b" .')).toBeNull(); // \| is GNU BRE alternation, already correct
  });

  it("run_shell surfaces the hint end-to-end for the exact stall-1 command shape", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-pipehint-"));
    mkdirSync(join(workspace, "pkg"));
    writeFileSync(join(workspace, "pkg", "code.go"), "package main\n", "utf8");

    const result = await runShellTool.run(
      { script: 'grep -rn "launchStep|LaunchStep|launch_step|AppLaunchStep" pkg/ --include="*.go" 2>&1', timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/literal pipe/i);
    expect(result.summary).toMatch(/grep -E/);
  });

  it("run_shell does not add the hint when -E is already used", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-pipehint-noop-"));
    writeFileSync(join(workspace, "code.go"), "package main\n", "utf8");

    const result = await runShellTool.run(
      { script: 'grep -rnE "a|b" .', timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).not.toMatch(/literal pipe/i);
  });

  it("run_command surfaces the hint end-to-end (args array, no shell parsing)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-command-pipehint-"));
    writeFileSync(join(workspace, "code.go"), "package main\n", "utf8");

    const result = await runCommandTool.run(
      { command: "grep", args: ["-rn", "a|b", "."], timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/literal pipe/i);
  });
});

describe("piped-grep no-match ambiguity (the pipefail build-filter stall)", () => {
  // The recurring live stall: `set -o pipefail && xcodebuild … | grep -E
  // "error:" | head -40` exits 1 with NO output whenever grep matches
  // nothing — which is exactly what a CLEAN build produces. The model saw
  // "Shell exited 1", assumed failure, and re-ran the identical command.

  it("explains exit 1 + empty output from a pipefail grep pipeline instead of a bare failure", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-pipegrep-"));

    const result = await runShellTool.run(
      { script: 'set -o pipefail && printf "BUILD OK\\n" | grep -E "error:" | head -40', timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("FILTER matched nothing");
    expect(result.summary).toContain('BUILD (SUCCEEDED|FAILED)');
    expect(result.summary).toContain("Do not re-run the same command");
  });

  it("leaves a matching pipeline untouched (errors flow through)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-pipegrep-match-"));

    const result = await runShellTool.run(
      { script: 'set -o pipefail && printf "error: boom\\n" | grep -E "error:" | head -40', timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(true);
    expect(String(result.output)).toContain("error: boom");
  });

  it("does not relabel exit 1 without a grep segment in the pipeline", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-pipegrep-none-"));

    const result = await runShellTool.run(
      { script: "false", timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(false);
    expect(result.summary).not.toContain("FILTER matched nothing");
  });

  it("pipedSearchNoMatchSummary is null without a piped search segment", () => {
    expect(pipedSearchNoMatchSummary("xcodebuild build")).toBeNull();
    expect(pipedSearchNoMatchSummary("grep -rn foo .")).toBeNull();
    expect(pipedSearchNoMatchSummary('xcodebuild build 2>&1 | grep -E "error:"')).toContain("FILTER matched nothing");
  });
});

describe("masked-verification: error filters must keep the verdict visible", () => {
  it("blocks the exact recurring FinanceWorld shape before it runs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-vet-grep-"));

    const result = await runShellTool.run(
      { script: 'cd . && set -o pipefail && xcodebuild -project CosmoFinance.xcodeproj -scheme CosmoFinance -destination \'platform=macOS\' CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -E "error:" | head -40', timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toBe("Shell verification rejected by safety checks.");
    expect(String(result.error)).toContain('BUILD (SUCCEEDED|FAILED)');
  });

  it("lets a verdict-visible filter through the vet", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-vet-ok-"));

    const result = await runShellTool.run(
      { script: 'set -o pipefail && ./gradlew help 2>&1 | grep -E "error:|BUILD (SUCCEEDED|FAILED)"', timeoutMs: 6_000 },
      { workspace },
    );

    // ./gradlew does not exist in the temp workspace, so the command runs and
    // fails — but it must NOT be a pre-execution safety block.
    expect(result.summary).not.toBe("Shell verification rejected by safety checks.");
  });
});

describe("missing-path existence probes (ls/stat on an absent path is an answer)", () => {
  // The live loop: a run verified a cleanup with `ls -la <dir>/ 2>&1`, got
  // exit 1 + "No such file or directory" — which PROVED the cleanup worked —
  // read it as a failure, and re-probed until the stall backstop fired.

  it("treats ls on a missing directory as the answer ABSENT, not a failure (the stalled shape)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-probe-"));

    const result = await runShellTool.run(
      { script: `ls -la ${workspace}/definitely-gone-dir/ 2>&1`, timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Path does not exist");
    expect(result.summary).toContain("Do not re-run the probe");
  });

  it("stat on a missing path is also the answer", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-probe-stat-"));

    const result = await runShellTool.run(
      { script: `stat ${workspace}/nope.txt`, timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Path does not exist");
  });

  it("keeps a normal ls listing untouched", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-probe-ok-"));
    writeFileSync(join(workspace, "present.txt"), "x\n", "utf8");

    const result = await runShellTool.run(
      { script: "ls -la .", timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).not.toContain("Path does not exist");
    expect(String(result.output)).toContain("present.txt");
  });

  it("a chained ls keeps real failure semantics", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-probe-chain-"));

    const result = await runShellTool.run(
      { script: `ls ${workspace}/gone-dir && echo listed`, timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(false);
    expect(result.summary).not.toContain("probe's answer");
  });

  it("a real ls error without 'No such file' stays a failure", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-probe-flag-"));

    const result = await runShellTool.run(
      { script: "ls --definitely-not-a-flag-xyz .", timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(false);
    expect(result.summary).not.toContain("Path does not exist");
  });

  it("run_command ls probe answers ABSENT end-to-end", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-command-probe-"));

    const result = await runCommandTool.run(
      { command: "ls", args: ["-la", join(workspace, "missing-dir")], timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Path does not exist");
  });
});

describe("key error lines extraction (large failing build logs)", () => {
  // A megabyte xcodebuild log defeats the model-facing head+tail truncation:
  // the error: lines sit in the dropped middle and the model retries the
  // build blind. Failing results with large output must LEAD with the
  // extracted error lines so any truncation window keeps them.

  it("prepends buried error lines to a large failing output", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-keyerr-"));

    const result = await runShellTool.run(
      {
        script: 'yes noiseline | head -3000; echo "/tmp/App.swift:10:5: error: cannot find Foo in scope"; yes tailnoise | head -3000; exit 65',
        timeoutMs: 10_000,
      },
      { workspace },
    );

    expect(result.ok).toBe(false);
    const output = String(result.output);
    expect(output.startsWith("## Key error lines")).toBe(true);
    expect(output.slice(0, 1_000)).toContain("error: cannot find Foo in scope");
    // The error field leads with the extracted lines too.
    expect(String(result.error)).toContain("Key error lines");
  }, 20_000);

  it("dedupes repeated error lines (xcodebuild repeats each)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-keyerr-dupe-"));

    const result = await runShellTool.run(
      {
        script: 'yes pad | head -3000; for i in 1 2 3; do echo "/x/B.swift:8:1: error: expected }"; done; yes pad2 | head -3000; exit 65',
        timeoutMs: 10_000,
      },
      { workspace },
    );

    const head = String(result.output).slice(0, 600);
    expect((head.match(/expected }/g) ?? []).length).toBe(1);
  }, 20_000);

  it("adds nothing to large SUCCESSFUL outputs or small failing ones", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-run-shell-keyerr-ok-"));

    const big = await runShellTool.run(
      { script: 'yes "error: not really, exit 0 wins" | head -3000', timeoutMs: 10_000 },
      { workspace },
    );
    expect(big.ok).toBe(true);
    expect(String(big.output)).not.toContain("## Key error lines");

    const small = await runShellTool.run(
      { script: 'echo "a.c:1: error: boom"; exit 1', timeoutMs: 10_000 },
      { workspace },
    );
    expect(small.ok).toBe(false);
    expect(String(small.output)).not.toContain("## Key error lines");
  }, 20_000);

  it("keyErrorLinesBlock is null for small output and picks TS/gradle shapes", () => {
    expect(keyErrorLinesBlock("short error: x")).toBeNull();
    const pad = "z".repeat(17_000);
    const block = keyErrorLinesBlock(`${pad}\nsrc/a.ts(3,1): error TS2304: Cannot find name 'x'.\nFAILURE: Build failed with an exception.\n`);
    expect(block).toContain("error TS2304");
    expect(block).toContain("FAILURE: Build failed");
  });
});

describe("GNU-flag-on-BSD guidance (beta.29 — the cat -A stall)", () => {
  // GNU cat accepts -A, so the failure this guidance reacts to only exists on
  // BSD userland; on Linux the command legitimately succeeds.
  it.skipIf(process.platform !== "darwin")("guides cat -A to cat -evt (the live stalled shape)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-bsd-cat-"));
    writeFileSync(join(workspace, "f.txt"), "line\n", "utf8");

    const result = await runShellTool.run(
      { script: "sed -n '1,2p' f.txt | cat -A", timeoutMs: 6_000 },
      { workspace },
    );

    expect(result.ok).toBe(false);
    expect(String(result.output)).toContain("BSD userland");
    expect(String(result.output)).toContain("cat -evt");
    expect(String(result.output)).toContain("Do NOT retry");
    // Original tool error stays visible after the guidance.
    expect(String(result.output)).toContain("illegal option");
  });
});

describe("bsdFlagGuidance (pure)", () => {
  it("maps the captured wordings to their BSD recipes", () => {
    expect(bsdFlagGuidance("cat: illegal option -- A\nusage: cat [-belnstuv] [file ...]", 1)).toContain("cat -evt");
    expect(bsdFlagGuidance("date: illegal option -- d\nusage: date [-jnRu]", 1)).toContain("date -v+1d");
    // Any --long option: BSD getopt reports the flag as a bare `-`.
    expect(bsdFlagGuidance("stat: illegal option -- -\nusage: stat [-FLnq]", 1)).toContain("stat -f");
    expect(bsdFlagGuidance("du: unrecognized option `--max-depth=1'\nusage: du", 1)).toContain("du -d");
  });

  it("gives generic man-page guidance for unmapped tools", () => {
    const guidance = bsdFlagGuidance("paste: illegal option -- z\nusage: paste", 1);
    expect(guidance).toContain("man paste");
  });

  it("never fires on GNU wordings, success, or unrelated errors", () => {
    // GNU getopt spells it differently — a Linux box must not trigger this.
    expect(bsdFlagGuidance("cat: invalid option -- 'A'\nTry 'cat --help'", 1)).toBeNull();
    expect(bsdFlagGuidance("du: unrecognized option '--max-depthx'", 1)).toBeNull();
    expect(bsdFlagGuidance("cat: illegal option -- A", 0)).toBeNull();
    expect(bsdFlagGuidance("error: something else entirely", 1)).toBeNull();
  });
});
