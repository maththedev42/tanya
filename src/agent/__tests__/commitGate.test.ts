import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitRequiredForRun, commitStillRequired } from "../git";
import { buildCommitRequiredReminder, runAgent, type TanyaFinalManifest } from "../runner";
import type { ChatProvider, ChatRequest, ToolCall } from "../../providers/types";
import type { TanyaRunContext } from "../../context/runContext";

function manifest(overrides: Partial<TanyaFinalManifest> = {}): TanyaFinalManifest {
  return {
    schemaVersion: 1,
    changedFiles: [],
    uncommittedFiles: [],
    artifactsRead: [],
    artifactsCreated: [],
    contextFilesRead: [],
    verification: [],
    git: { root: "/repo", head: "abc1234" },
    toolErrors: 0,
    blockers: [],
    ...overrides,
  } as TanyaFinalManifest;
}

const rc = (value: unknown): TanyaRunContext => value as TanyaRunContext;

describe("commitRequiredForRun — FIX 1: gate defaults ON for ad-hoc runs", () => {
  it("ad-hoc run (no runContext) with changed files requires a commit", () => {
    expect(commitRequiredForRun(undefined, true)).toBe(true);
  });

  it("ad-hoc run with no changed files does not", () => {
    expect(commitRequiredForRun(undefined, false)).toBe(false);
  });

  it("explicit metadata.requireCommit === false opts out (programmatic caller)", () => {
    expect(commitRequiredForRun(rc({ metadata: { requireCommit: false } }), true)).toBe(false);
  });

  it("pipeline run (runContext present, no commit flags) does NOT require a commit — regression guard", () => {
    expect(commitRequiredForRun(rc({}), true)).toBe(false);
    expect(commitRequiredForRun(rc({ metadata: {} }), true)).toBe(false);
  });

  it("pipeline run keeps opt-in: requireCommit:true or expected_report.commit still requires it", () => {
    expect(commitRequiredForRun(rc({ metadata: { requireCommit: true } }), true)).toBe(true);
    expect(commitRequiredForRun(rc({ expected_report: { commit: true } }), true)).toBe(true);
  });
});

describe("commitStillRequired", () => {
  it("ad-hoc run with in-scope uncommitted files is still required", () => {
    expect(commitStillRequired(manifest({ changedFiles: ["a.ts"], uncommittedFiles: ["a.ts"] }), null, undefined)).toBe(true);
  });

  it("ad-hoc run is satisfied once HEAD advanced and nothing is uncommitted", () => {
    const before = { head: "0000000deadbeef" } as unknown as Parameters<typeof commitStillRequired>[1];
    // manifest.git.head "abc1234" !== before.head.slice(0,7) "0000000" -> HEAD moved -> satisfied
    expect(commitStillRequired(manifest({ changedFiles: ["a.ts"], uncommittedFiles: [] }), before, undefined)).toBe(false);
  });

  it("pipeline run without commit flags is never required — regression guard", () => {
    expect(commitStillRequired(manifest({ changedFiles: ["a.ts"], uncommittedFiles: ["a.ts"] }), null, rc({}))).toBe(false);
  });
});

describe("buildCommitRequiredReminder — FIX 4: untracked-file blind spot", () => {
  it("tells the model created files are untracked until git add", () => {
    const text = buildCommitRequiredReminder(manifest({ changedFiles: ["edited.ts", "created.ts"], uncommittedFiles: ["created.ts"] }));
    expect(text).toContain("Files you CREATED this run are untracked");
    expect(text).toContain("git status --porcelain");
    expect(text).toContain("created.ts");
  });
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tanya-commitgate-e2e-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "app.txt"), "one\n");
  git(dir, ["add", "app.txt"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

// Reproduces the field failure: an AD-HOC run (no runContext) edits a file but
// never commits. Turn 1 edits app.txt; every later turn just reports done. With
// the fix, the commit gate arms (previously it never did for ad-hoc runs),
// re-arms up to the cap, then finalizes with a COMMIT INCOMPLETE report.
function neverCommitsProvider(seen: string[][]): ChatProvider {
  let calls = 0;
  return {
    id: "test",
    model: "test-model",
    async *streamChat(input: ChatRequest) {
      calls += 1;
      seen.push(input.messages.map((m) => (typeof m.content === "string" ? m.content : "")));
      if (calls === 1) {
        yield { toolCalls: [toolCall("c1", "write_file", { path: "app.txt", content: "one\ntwo\n" })] };
        return;
      }
      yield { content: "Modified: app.txt\nVerification: none\nArtifact reused: none\nArtifact created: none\nBlocked: none" };
    },
  };
}

describe("commit gate end-to-end — FIX 1 + FIX 3 (ad-hoc run, no runContext)", () => {
  it("arms for an ad-hoc run and reports COMMIT INCOMPLETE when work is left uncommitted", async () => {
    const repo = makeRepo();
    const seen: string[][] = [];
    const result = await runAgent({
      provider: neverCommitsProvider(seen),
      prompt: "append a second line to app.txt",
      cwd: repo,
      sink: async () => {},
      interactive: false,
      maxTurns: 15,
    });

    // FIX 1: the gate fired for an ad-hoc run (it never used to).
    const remindered = seen.some((msgs) => msgs.some((c) => /requires a git commit|CREATED this run are untracked/.test(c)));
    expect(remindered).toBe(true);

    // FIX 3: after the repair cap, the report leads with the incomplete block
    // and the manifest carries a blocker so it can't read as a clean pass.
    expect(result.message).toContain("COMMIT INCOMPLETE");
    expect(result.manifest.blockers.some((b) => /commit incomplete/i.test(b))).toBe(true);

    // Nothing was committed — the edit is still dirty in the tree.
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    expect(status).toContain("app.txt");
  }, 20_000);
});

// PROMPT B item 2: the PROMPT instructing a commit arms the gate even for a
// pipeline runContext that carries no commit flags — the audited FinanceWorld
// run's prompt said commit, its runContext didn't, so the gate stayed disarmed
// and nothing was committed under a green report.
describe("promptRequiresCommit — prompt-level arming", () => {
  it("arms on a plain commit instruction (en + pt)", async () => {
    const { promptRequiresCommit } = await import("../git");
    expect(promptRequiresCommit("Do the work. Commit path-limited at the end.")).toBe(true);
    expect(promptRequiresCommit("Implemente e commite path-limited.")).toBe(true);
    expect(promptRequiresCommit("Rode a suíte e commit no final.")).toBe(true);
  });

  it("does NOT arm when the prompt only forbids committing", async () => {
    const { promptRequiresCommit } = await import("../git");
    expect(promptRequiresCommit("Fix the bug but do not commit anything.")).toBe(false);
    expect(promptRequiresCommit("Explore the repo. Não commite nada.")).toBe(false);
  });

  it("a forbid + a separate positive instruction still arms", async () => {
    const { promptRequiresCommit } = await import("../git");
    expect(promptRequiresCommit("Don't commit the scratch dir. Commit the src changes.")).toBe(true);
  });

  it("no commit mention → not armed", async () => {
    const { promptRequiresCommit } = await import("../git");
    expect(promptRequiresCommit("Fix the bug and run the tests.")).toBe(false);
  });
});

describe("prompt-armed commit gate through buildFinalManifest (pipeline runContext)", () => {
  it("blocks uncommitted session files when the prompt says commit but the runContext has no commit flags", async () => {
    const repo = makeRepo();
    // Session writes a file and leaves it uncommitted.
    writeFileSync(join(repo, "new.txt"), "written by the session\n");
    const { captureGitSnapshot } = await import("../git");
    const { buildFinalManifest } = await import("../report");
    const before = await captureGitSnapshot(repo);

    const manifest = await buildFinalManifest({
      workspace: repo,
      beforeGitSnapshot: before,
      changed: ["new.txt"],
      verificationLines: [],
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      // Pipeline shape: runContext present, NO requireCommit flag anywhere.
      runContext: rc({ task: { kind: "coding" }, metadata: {} }),
      prompt: "## Part 1 — feature\nBuild it.\n## Part 2 — ship\nCommite path-limited no final.",
      interactive: false,
    });

    expect(manifest.blockers.some((b) => /commit incomplete/i.test(b))).toBe(true);
    expect(manifest.gateLog).toContain("commit-gate: armed by prompt commit instruction");
  }, 30_000);

  it("metadata.requireCommit === false still opts the pipeline out, prompt or not", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "new.txt"), "written by the session\n");
    const { captureGitSnapshot } = await import("../git");
    const { buildFinalManifest } = await import("../report");
    const before = await captureGitSnapshot(repo);

    const manifest = await buildFinalManifest({
      workspace: repo,
      beforeGitSnapshot: before,
      changed: ["new.txt"],
      verificationLines: [],
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      runContext: rc({ task: { kind: "coding" }, metadata: { requireCommit: false } }),
      prompt: "## Part 1 — feature\nBuild it.\n## Part 2 — ship\nCommit at the end.",
      interactive: false,
    });

    expect(manifest.blockers.some((b) => /commit incomplete/i.test(b))).toBe(false);
  }, 30_000);
});
