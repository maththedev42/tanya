import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../runner";
import type { ChatProvider, ToolCall } from "../../providers/types";

// CANARY (gate-escape acceptance test). Drives the REAL runAgent through the
// interactive path — the exact code path the mac app hits (serveStdio passes
// interactive:true) and the one that used to bypass every gate — against a
// deliberately gate-violating task, and proves the run now FAILS naming all
// three objective violations. Deterministic (mock provider, no network).
//
// The task (task-shaped: 3 numbered deliverables + a ## Verify section):
//   (a) writes a new source file and never commits it   -> commit-completeness
//   (b) addresses only 2 of the 3 deliverables          -> spec-coverage
//   (c) never runs the required Verify command           -> verify-gate

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function canaryRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tanya-canary-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@e.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" }); // nothing yet
  // seed commit so HEAD exists
  execFileSync("bash", ["-lc", "echo seed > README.md"], { cwd: dir });
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

// Writes a new file (never committed), then "finishes" with a report that
// mentions only Part 1 + Part 2 and runs no verification.
function violatingProvider(): ChatProvider {
  let calls = 0;
  return {
    id: "test",
    model: "test-model",
    async *streamChat() {
      calls += 1;
      if (calls === 1) {
        yield { toolCalls: [toolCall("c1", "write_file", { path: "src/feature.swift", content: "struct Feature {}\n" })] };
        return;
      }
      // No tool calls, no verify run, only 2 of 3 deliverables mentioned.
      yield { content: "Done: Part 1 created src/feature.swift, and Part 2 referenced it. Looks good." };
    },
  };
}

const CANARY_PROMPT = [
  "# Canary task",
  "",
  "## Part 1 — create the feature file",
  "Create `src/feature.swift`.",
  "",
  "## Part 2 — reference it",
  "Reference the new type somewhere.",
  "",
  "## Part 3 — add coverage",
  "Add a small regression somewhere.",
  "",
  "## Verify",
  "1. Run `npm test` and confirm it passes.",
].join("\n");

describe("gate canary — interactive task run FAILS on all three objective gates", () => {
  it("verdict is FAILED and names the uncommitted file, the missing deliverable, and the unrun verify command", async () => {
    const dir = canaryRepo();
    const result = await runAgent({
      provider: violatingProvider(),
      prompt: CANARY_PROMPT,
      cwd: dir,
      sink: async () => {},
      runContext: { task: { kind: "coding", title: "canary" } },
      interactive: true, // the path that used to bypass everything
      maxTurns: 8,
    });

    const msg = result.message;
    const blockers = result.manifest.blockers.join(" | ");

    // Verdict
    expect(msg).toMatch(/TANYA RESULT:\s*FAIL/);

    // (a) commit-completeness — names the uncommitted file
    expect(blockers).toMatch(/Commit incomplete/i);
    expect(blockers).toContain("src/feature.swift");

    // (b) spec-coverage — Part 3 unaccounted
    expect(result.manifest.specCoverage?.find((c) => /Part 3/i.test(c.id))?.status).toBe("pending");
    expect(blockers).toMatch(/Spec coverage incomplete/i);

    // (c) verify-gate — npm test never run
    expect(blockers).toMatch(/Verify step\(s\) not executed/i);
    expect(blockers).toContain("npm test");
  });

  it("writes a top-level run archive with the blockers recorded", async () => {
    const dir = canaryRepo();
    await runAgent({
      provider: violatingProvider(),
      prompt: CANARY_PROMPT,
      cwd: dir,
      sink: async () => {},
      runContext: { task: { kind: "coding", title: "canary" } },
      interactive: true,
      maxTurns: 8,
    });
    const runsDir = join(dir, ".tanya", "runs");
    expect(existsSync(runsDir)).toBe(true);
    const files = (await readdir(runsDir)).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    const record = JSON.parse(readFileSync(join(runsDir, files[0] as string), "utf8")) as {
      archiveVersion?: number;
      blockers: string[];
      verdict?: string;
      gateLog?: string[];
      binaryVersion?: string;
      gates?: {
        armed: boolean;
        armedReason: string;
        verifyGate?: { status: string; commands: { cmd: string; verified: boolean }[] };
        commitCompleteness?: { status: string; uncommitted: string[] };
        specCoverage?: { status: string; items: { id: string; state: string }[] };
      };
    };
    expect(record.blockers.some((b) => /Commit incomplete/i.test(b))).toBe(true);
    expect(record.verdict).toBe("FAIL");

    // archiveVersion 2 + binary identity: forensics never has to guess which
    // code ran.
    expect(record.archiveVersion).toBe(2);
    expect(typeof record.binaryVersion).toBe("string");

    // Structured gates section: an auditor reads each verdict straight from the
    // archive instead of reverse-engineering it from git.
    expect(record.gates?.armed).toBe(true);
    expect(record.gates?.armedReason).toMatch(/task-shaped|coding task/i);
    expect(record.gates?.verifyGate?.status).toBe("fail");
    expect(record.gates?.verifyGate?.commands.some((c) => c.cmd.includes("npm test") && !c.verified)).toBe(true);
    expect(record.gates?.commitCompleteness?.status).toBe("fail");
    expect(record.gates?.commitCompleteness?.uncommitted.some((f) => f.includes("feature.swift"))).toBe(true);
    expect(record.gates?.specCoverage?.status).toBe("fail");
    expect(record.gates?.specCoverage?.items.find((i) => /Part 3/i.test(i.id))?.state).toBe("pending");
  });
});
