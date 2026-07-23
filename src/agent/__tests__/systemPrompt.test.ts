import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRepoMap } from "../../context/repoMap";
import { buildSystemPrompt, selectLiteSkillPacks } from "../systemPrompt";
import type { LoadedSkillPack } from "../../skills";

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), "tanya-lite-system-prompt-"));
}

function fakePack(slug: string): LoadedSkillPack {
  return {
    slug,
    title: slug,
    sourcePath: `/skills/${slug}.md`,
    content: `${slug} guidance`,
    tokens: 10,
    reason: slug.startsWith("failure-modes/") ? "always" : "workspace",
  };
}

describe("lite system prompt", () => {
  it("cuts representative coding prompt tokens by at least 60% while preserving workspace facts", () => {
    const root = makeProject();
    mkdirSync(join(root, "artifacts", "backend"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
    writeFileSync(join(root, "next.config.ts"), "export default {};\n");
    writeFileSync(join(root, "artifacts", "README.md"), "artifact guidance\n".repeat(900));
    writeFileSync(join(root, "artifacts", "backend", "ApiPattern.md"), "api pattern\n".repeat(900));
    const historyBlock = [
      "## Recent task history",
      ...Array.from({ length: 24 }, (_, index) => `- [2026-05-${String(index + 1).padStart(2, "0")}] PASSED: "${"history ".repeat(120)}" -> changed: src/file-${index}.ts`),
    ].join("\n");

    const full = buildSystemPrompt(root, {
      languages: ["typescript"],
      frameworks: ["nextjs"],
      stack: "nextjs-reference",
    }, historyBlock, "Refactor a Next.js page component");
    const lite = buildSystemPrompt(root, {
      languages: ["typescript"],
      frameworks: ["nextjs"],
      stack: "nextjs-reference",
    }, historyBlock, "Refactor a Next.js page component", { lite: true });

    expect(Math.ceil(lite.length / 4)).toBeLessThanOrEqual(Math.floor(Math.ceil(full.length / 4) * 0.4));
    expect(lite).toContain("## Workspace Context");
    expect(lite).toContain("package.json");
    expect(lite).not.toContain("## Artifact Index");
    expect((lite.match(/PASSED:/g) ?? [])).toHaveLength(1);
    // Both modes must tell the agent to search before declaring absence /
    // scaffolding fresh (the cosa-nostra "doesn't exist" failure).
    expect(full).toContain("before treating the task as greenfield or scaffolding a fresh copy");
    expect(lite).toContain("Before assuming a referenced project");
    // Both modes must tell the agent that committing finished work is the
    // default final step, with a path-limited add — Tanya was leaving green
    // work uncommitted because the guidance was buried and caller-conditional.
    for (const prompt of [full, lite]) {
      expect(prompt.toLowerCase()).toContain("commit");
      expect(prompt).toContain("git add -A");
    }
  });

  it("keeps artifact index in lite mode once artifact activity is recorded", () => {
    const root = makeProject();
    mkdirSync(join(root, "artifacts"), { recursive: true });
    writeFileSync(join(root, "artifacts", "README.md"), "artifact guidance\n");

    const lite = buildSystemPrompt(root, {
      metadata: { artifactsRead: ["artifacts/README.md"] },
    }, "", "Use the known artifact", { lite: true });

    expect(lite).toContain("## Artifact Index");
  });

  it("drops unmatched domain skill packs in lite mode but keeps failure, language, framework, and matched domain packs", () => {
    const selected = selectLiteSkillPacks([
      fakePack("failure-modes/verify-mode"),
      fakePack("lang/typescript"),
      fakePack("framework/nextjs-app-router"),
      fakePack("domain/auth-jwt"),
      fakePack("domain/stripe"),
      fakePack("domain/push-notifications"),
    ], "Fix auth token refresh in a Next.js route");

    expect(selected.map((pack) => pack.slug)).toEqual([
      "failure-modes/verify-mode",
      "lang/typescript",
      "framework/nextjs-app-router",
      "domain/auth-jwt",
    ]);
  });

  it("enforces provider prompt budgets by dropping optional sections in deterministic priority order", () => {
    const root = makeProject();
    mkdirSync(join(root, "artifacts", "web"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
    writeFileSync(join(root, "next.config.ts"), "export default {};\n");
    writeFileSync(join(root, "artifacts", "README.md"), "artifact guidance\n".repeat(1200));
    writeFileSync(join(root, "artifacts", "web", "Pattern.md"), "pattern\n".repeat(1200));
    const events: Array<{ droppedSections: string[]; totalTokens: number; cap: number }> = [];

    const prompt = buildSystemPrompt(root, {
      languages: ["typescript"],
      frameworks: ["nextjs"],
      stack: "nextjs-reference",
    }, "", "Build a Next.js settings page", {
      contextWindow: 32_000,
      promptBudgetRatio: 0.25,
      onPromptBudgetExceeded: (event) => events.push(event),
    });

    expect(Math.ceil(prompt.length / 4)).toBeLessThanOrEqual(8_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.cap).toBe(8_000);
    expect(events[0]?.droppedSections.slice(0, 2)).toEqual(["failure-mode packs", "artifact index"]);
    expect(prompt).toContain("## Workspace Context");
  });

  it("adds cached repo-map context to lite prompts and drops it first under tight budgets", async () => {
    const root = makeProject();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "auth.ts"), [
      "export function verifySession() {",
      "  return true;",
      "}",
    ].join("\n"));
    await buildRepoMap(root, { writeCache: true });

    const lite = buildSystemPrompt(root, undefined, "", "Fix verifySession", { lite: true });
    expect(lite).toContain("## Repo Map (advisory)");
    expect(lite).toContain("src/auth.ts");

    const events: Array<{ droppedSections: string[]; totalTokens: number; cap: number }> = [];
    const tight = buildSystemPrompt(root, undefined, "", "Fix verifySession", {
      lite: true,
      contextWindow: 1_000,
      promptBudgetRatio: 0.1,
      onPromptBudgetExceeded: (event) => events.push(event),
    });

    expect(events[0]?.droppedSections[0]).toBe("repo-map");
    expect(tight).not.toContain("## Repo Map (advisory)");
  });
});

describe("definition-of-done block", () => {
  it("injects a runtime-verification definition of done for app-shaped coding tasks", () => {
    const root = makeProject();
    const prompt = buildSystemPrompt(root, { task: { kind: "coding" } }, "", "build an iOS calculator app");
    expect(prompt).toContain("Definition of done");
    expect(prompt).toContain("tanya test-app --tier1");
    // the calculator-specific behavioural criteria are surfaced
    expect(prompt).toMatch(/digit button/i);
  });

  it("omits the block for non-coding tasks", () => {
    const root = makeProject();
    // "Definition of done" is unique to the injected block; the base prompt's
    // general `tanya test-app` guidance does not use that phrase.
    const prompt = buildSystemPrompt(root, undefined, "", "build an iOS calculator app");
    expect(prompt).not.toContain("Definition of done");
  });

  it("omits the block for coding tasks with no runtime-checkable behaviour", () => {
    const root = makeProject();
    const prompt = buildSystemPrompt(root, { task: { kind: "coding" } }, "", "fix a typo in the README");
    expect(prompt).not.toContain("Definition of done");
  });
});

describe("pre-finish checklist block", () => {
  it("ships the full 7-item checklist in the non-lite prompt", () => {
    const root = makeProject();
    const prompt = buildSystemPrompt(root, { task: { kind: "coding" } }, "", "wire a new save path");
    expect(prompt).toContain("## Pre-finish checklist (coding)");
    // The novel rules that review had to catch by hand:
    expect(prompt).toContain("Shared-state writes:");
    expect(prompt).toMatch(/read the current value and MERGE it/);
    expect(prompt).toContain("Precedent first:");
    expect(prompt).toContain("Green and reported:");
    expect(prompt).toContain("Spike before feature:");
    expect(prompt).toContain("Leave no trace:");
    expect(prompt).toContain("Per-task status:");
    expect(prompt).toMatch(/Hosted, not base64:/);
    // API-existence habit (PROMPT B2 item 5): the FinanceWorld T2 run invented
    // three cross-file APIs in one file and never compiled.
    expect(prompt).toMatch(/[Nn]ever write cross-file calls from memory/);
    // Rule 8, from the beta.17 Kimi review: the commit message claimed a feat
    // that pre-existed and tests that were never written.
    // PROMPT B3 item 5: UI-written state must be consumed by the execution
    // path (run 3: deselectedRowIDs/rowCategories/createInstallmentsForRowID
    // were written by the import UI and silently ignored by doImport).
    expect(prompt).toContain("State wired end-to-end:");
    expect(prompt).toMatch(/only reader is the UI/);
    expect(prompt).toContain("Honest ledger:");
    expect(prompt).toMatch(/staged diff/);
    expect(prompt).toMatch(/already present \(verified/);
  });

  it("ships a compressed checklist in lite mode that keeps the shared-state and base64 rules", () => {
    const root = makeProject();
    const lite = buildSystemPrompt(root, { task: { kind: "coding" } }, "", "wire a new save path", { lite: true });
    expect(lite).toContain("## Pre-finish checklist (coding)");
    // The single most damaging first-pass miss (blind overwrite of a shared
    // field) and the base64 + claim-accuracy rules must survive compression.
    expect(lite).toMatch(/read-merge-dedupe instead of overwriting/);
    expect(lite).toMatch(/hosted URLs, never data: base64/);
    expect(lite).toMatch(/ONLY what the staged diff contains/);
    // The API-existence habit survives into lite (compressed form).
    expect(lite).toContain("never write cross-file calls from memory");
    // The UI-state wiring rule survives into lite (compressed form).
    expect(lite).toContain("must be READ by the execution path");
    // Lite stays terse: it must NOT carry the full multi-line bullet list.
    expect(lite).not.toContain("Spike before feature:");
    expect(lite).not.toContain("Honest ledger:");
  });

  it("prompt gating: orchestration block present only when subagentToolsEnabled", () => {
    const root = makeProject();
    const withTools = buildSystemPrompt(
      root,
      { task: { kind: "coding" } },
      "",
      "dispatch a subagent",
      { lite: true, subagentToolsEnabled: true },
    );
    expect(withTools).toContain("## Subagent orchestration");
    expect(withTools).toContain("numbered deliverables");

    const withoutTools = buildSystemPrompt(
      root,
      { task: { kind: "coding" } },
      "",
      "dispatch a subagent",
      { lite: true, subagentToolsEnabled: false },
    );
    expect(withoutTools).not.toContain("## Subagent orchestration");
    expect(withoutTools).not.toContain("numbered deliverables");

    // Default (no flag): block is absent.
    const defaultPrompt = buildSystemPrompt(
      root,
      { task: { kind: "coding" } },
      "",
      "dispatch a subagent",
      { lite: true },
    );
    expect(defaultPrompt).not.toContain("## Subagent orchestration");
  });
});
