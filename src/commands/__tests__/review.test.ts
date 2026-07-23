import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../index";
import type { ChatDelta, ChatProvider, ChatRequest } from "../../providers/types";

class MemoryStream {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

// The reviewer never touches a real endpoint in tests: this stub captures the
// request and yields a canned review. Pin the provider env away from DeepSeek
// as belt-and-suspenders (the dev machine may carry a live DEEPSEEK_API_KEY).
class StubProvider implements ChatProvider {
  id = "custom";
  model = "stub-reviewer";
  requests: ChatRequest[] = [];
  reply: string;

  constructor(reply = "## Review\n**Verdict:** NEEDS CHANGES\n\n**Issues:**\n- app.txt:1 — off-by-one") {
    this.reply = reply;
  }

  async *streamChat(input: ChatRequest): AsyncGenerator<ChatDelta> {
    this.requests.push(input);
    yield { content: this.reply };
  }
}

beforeEach(() => {
  vi.stubEnv("TANYA_PROVIDER", "custom");
  vi.stubEnv("TANYA_API_KEY", "");
  vi.stubEnv("DEEPSEEK_API_KEY", "");
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "tanya-review-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "app.txt"), "line one\n");
  git(repo, ["add", "app.txt"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

function userMessage(provider: StubProvider): string {
  const request = provider.requests[0];
  const user = request?.messages.find((m) => m.role === "user");
  return typeof user?.content === "string" ? user.content : "";
}

describe("/review command", () => {
  it("feeds the working-tree diff to the reviewer and prints the verdict", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "app.txt"), "line one changed\n");
    const provider = new StubProvider();
    const output = new MemoryStream();

    await expect(runCommand("/review", {
      cwd: repo,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
      provider,
    })).resolves.toBe(true);

    expect(provider.requests).toHaveLength(1);
    // The actual working-tree change must reach the reviewer.
    expect(userMessage(provider)).toContain("line one changed");
    const text = output.chunks.join("");
    expect(text).toContain("Reviewing working-tree changes");
    expect(text).toContain("NEEDS CHANGES");
  });

  it("lists untracked files so new files aren't invisible to the reviewer", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "brand-new.ts"), "export const x = 1;\n");
    const provider = new StubProvider();
    const output = new MemoryStream();

    await runCommand("/review", {
      cwd: repo,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
      provider,
    });

    expect(userMessage(provider)).toContain("new (untracked): brand-new.ts");
  });

  it("reviews the staged diff with --staged and skips the working tree", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "app.txt"), "staged edit\n");
    git(repo, ["add", "app.txt"]);
    // A second, unstaged change that must NOT appear in a --staged review.
    writeFileSync(join(repo, "app.txt"), "staged edit\nunstaged tail\n");
    const provider = new StubProvider();
    const output = new MemoryStream();

    await runCommand("/review --staged", {
      cwd: repo,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
      provider,
    });

    const prompt = userMessage(provider);
    expect(prompt).toContain("staged edit");
    expect(prompt).not.toContain("unstaged tail");
    expect(output.chunks.join("")).toContain("Reviewing staged changes");
  });

  it("prints 'Nothing to review.' and never calls the provider on a clean tree", async () => {
    const repo = makeRepo();
    const provider = new StubProvider();
    const output = new MemoryStream();

    await runCommand("/review", {
      cwd: repo,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
      provider,
    });

    expect(provider.requests).toHaveLength(0);
    expect(output.chunks.join("")).toContain("Nothing to review.");
  });

  it("reports a clear error outside a git repository", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "tanya-review-nogit-"));
    const provider = new StubProvider();
    const output = new MemoryStream();

    await runCommand("/review", {
      cwd: notARepo,
      output: output as unknown as NodeJS.WritableStream,
      sink: () => {},
      provider,
    });

    expect(provider.requests).toHaveLength(0);
    expect(output.chunks.join("")).toContain("needs a git repository");
  });
});
