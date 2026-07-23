import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../runner";
import type { ChatProvider, ChatRequest, ToolCall } from "../../providers/types";

// Classified stall messages (Part 2). beta.13/14 already classify a tool
// failure's `summary` (no-match search / shell parse error); this proves that
// classification — and the new baseline-aware "pre-existing" classification —
// reaches the interactive pause message's `Stuck on:` line, not just the raw
// tool-result stream, so a user pasting the stall detail sees WHY, not just an
// exit code.

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("classified stall messages reach the interactive pause detail", () => {
  it("a shell parse error's classification survives into Stuck on:, not a bare exit code", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tanya-stall-parse-"));
    // The unmatched-backtick shape from the live stall: zsh rejects it at
    // parse time and never executes the command.
    const malformedScript = 'grep -rn "AppLaunchStep" . --include="*.go" | grep -v "struct|`json"';
    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat() {
        yield { toolCalls: [toolCall(`c-${Math.random()}`, "run_shell", { script: malformedScript })] };
      },
    };

    const result = await runAgent({
      provider,
      prompt: "Keep trying the broken search.",
      cwd,
      sink: async () => {},
      maxTurns: 2,
      extendBudgetOnProgress: true,
    });

    expect(result.message).toMatch(/Stuck on:/);
    const stuckOn = result.message.slice(result.message.indexOf("Stuck on:"));
    expect(stuckOn).toMatch(/parse error/i);
    expect(stuckOn).toMatch(/NOT executed/);
    // Not just the bare exit code that hid the real cause in the live stall.
    expect(stuckOn).not.toMatch(/^Stuck on: Shell exited 1\.\s*$/m);
  }, 30_000);

  it("a pre-existing-failure classification survives into Stuck on:", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tanya-stall-baseline-"));
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@e.com"]);
    git(dir, ["config", "user.name", "T"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(dir, "go.mod"), "module example.com/stallfixture\n\ngo 1.21\n");
    mkdirSync(join(dir, "broken"), { recursive: true });
    writeFileSync(join(dir, "broken", "broken.go"), "package broken\n\nfunc AlwaysTrue() bool { return false }\n");
    writeFileSync(
      join(dir, "broken", "broken_test.go"),
      'package broken\n\nimport "testing"\n\nfunc TestAlwaysTrue(t *testing.T) {\n\tif !AlwaysTrue() {\n\t\tt.Fatal("pre-existing failure")\n\t}\n}\n',
    );
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "init (broken/ already red)"]);

    const provider: ChatProvider = {
      id: "test",
      model: "test-model",
      async *streamChat() {
        // Never touches any file — the broad test's only failure is entirely
        // untouched by this run.
        yield { toolCalls: [toolCall(`c-${Math.random()}`, "run_shell", { script: "go test ./..." })] };
      },
    };

    const result = await runAgent({
      provider,
      prompt: "Keep running the suite.",
      cwd: dir,
      sink: async () => {},
      maxTurns: 2,
      extendBudgetOnProgress: true,
    });

    expect(result.message).toMatch(/Stuck on:/);
    const stuckOn = result.message.slice(result.message.indexOf("Stuck on:"));
    expect(stuckOn).toMatch(/likely pre-existing failure/);
    expect(stuckOn).toMatch(/example\.com\/stallfixture\/broken/);
    expect(stuckOn).toMatch(/not caused by this run/);
  }, 30_000);
});
