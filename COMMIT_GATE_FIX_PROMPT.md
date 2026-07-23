# Tanya — Fix the "classic Tanya commit problems" (commit gate defaults off)

**Generated:** 2026-07-12. One self-contained prompt. Executor: Opus (or Tanya itself — the gate below applies to you too: **finish with a commit**).

## Field evidence (why this matters)

On 2026-07-11/12, Tanya executed 3 parity prompts in the CosmoRemote repo. Every prompt had a **bolded commit step**. Results:

1. Commit `bfd0db7` shipped code referencing 5 new string keys (`R.string.tests_runs_remaining` etc.) **but the 3 new `strings_tests_parity.xml` files were left untracked** — never `git add`ed. The commit does not compile on a fresh checkout.
2. Commit `c6776e8` added parameters to `QRScannerScreen` **but the 2-line call-site wiring in `MainScreen.kt` was modified and left uncommitted** — same broken-on-fresh-checkout failure.

Both would have been caught by Tanya's own gate (`manifest.uncommittedFiles` was non-empty in both cases). The gate never fired. This prompt fixes the arming conditions, not the detection.

## Root cause (verified in source)

- `src/agent/git.ts:262` — `runContextRequiresCommit()` returns `true` only when the caller passes `metadata.requireCommit === true` or `expected_report` includes `"commit"`. **Ad-hoc runs (CLI prompt, no runContext JSON) have `runContext === undefined` → the commit gate is permanently disarmed** in exactly the mode where users paste task prompts.
- `src/agent/runner.ts:2618` — `if (!interactive && !requestedCommitRepair && commitStillRequired(...))`: the repair reminder is additionally skipped for **interactive** sessions, and `requestedCommitRepair` is a **one-shot boolean** — if the model's repair commit is itself incomplete (commits edited files, forgets untracked new ones — the exact field failure), finalization proceeds silently.
- `src/agent/runner.ts:408` — `buildCommitRequiredReminder` never tells the model that **new files it created are untracked and invisible to `git commit <paths>` of edited files** — the specific blind spot behind failure #1.
- The system prompt (`src/agent/systemPrompt.ts:151,203,205,206`) already says commit-by-default. The behavioral gate contradicts it by being opt-in. Make the gate match the prompt.

--- PROMPT ---

In the Tanya repo (`/Users/matheus/Desktop/Projetos/Appzinhos/tanya`), fix the commit-completeness gate so it actually fires for the runs people use most. Read `src/agent/git.ts` (esp. `runContextRequiresCommit`, `commitStillRequired`, `uncommittedFilesSince`), `src/agent/runner.ts` (the two `commitStillRequired` call sites ~lines 2154 and 2618, `buildCommitRequiredReminder` ~line 408, `requestedCommitRepair`), and `src/tools/fsTools.ts` (`commitPlatformChangesTool`) before changing anything.

### FIX 1 — Commit gate defaults ON for ad-hoc coding runs (the core fix)

Change the commit-required semantics in `src/agent/git.ts`:

- **When `runContext` is absent/undefined** (ad-hoc CLI/interactive runs): commit is REQUIRED by default whenever the run changed files. Opt-out only via an explicit signal (support `metadata.requireCommit === false` for programmatic callers, and add a CLI flag `--no-commit-gate` if a natural flag-plumbing path exists; do not invent a prompt-text parser).
- **When a `runContext` object IS present** (pipeline callers — CosmoHQ V3 coding steps run Tanya this way): keep the CURRENT opt-in behavior exactly as-is (`metadata.requireCommit === true` or `expected_report` includes `"commit"`). 🔴 **Do not change gate behavior for runs with a runContext — the CosmoHQ V3 pipeline depends on current semantics (it manages worktree merges itself).**

Suggested shape: `runContextRequiresCommit(runContext)` keeps its meaning; add `commitRequiredForRun(runContext, hasChangedFiles)` used by `commitStillRequired`, with the default-on branch for `runContext == null`. Also update `src/agent/validators/core.ts:536`, which has the same opt-in pattern — apply the same default-on rule there so validator and gate agree.

### FIX 2 — Interactive runs get a visible warning (not a hard loop)

`runner.ts:2618` skips everything when `interactive`. Don't hard-loop interactive sessions; instead, when an interactive turn finishes with in-scope uncommitted files from this run (`uncommittedFilesSince(before, after, workspace)` non-empty), append a single warning line to the assistant's message (or emit the equivalent status event the UI renders):

`⚠ Uncommitted changes from this task: <path1>, <path2> — commit them or say they're intentionally left dirty.`

Pre-existing dirt (files already dirty in `beforeGitSnapshot`) must NOT be listed — only files this run touched. No warning when nothing changed.

### FIX 3 — Repair loop re-arms until clean (max 3 attempts)

Replace the `requestedCommitRepair` boolean with an attempt counter (cap 3). After each repair `continue`, the manifest is rebuilt; if `commitStillRequired` is STILL true, remind again — with only the REMAINING missing paths. After the cap, finalize, but the final report must start with an explicit block:

```
⚠ COMMIT INCOMPLETE — these in-scope files are not in any commit:
<paths>
```

and the report footer/verdict must not read as a clean pass.

### FIX 4 — Reminder text teaches the untracked-file blind spot

In `buildCommitRequiredReminder` (`runner.ts:408`), add one line:

`Files you CREATED this run are untracked — git only commits them after an explicit \`git add\` / inclusion in commit_platform_changes \`files\`. Check \`git status --porcelain\` for \`??\` entries before reporting done.`

Keep the existing amend guidance.

### FIX 5 — `commit_platform_changes` warns about missing in-scope files (best-effort)

In `commitPlatformChangesTool` (`src/tools/fsTools.ts:2124`): if the tool context can reach the run's before-snapshot (plumb it through tool context if a clean path exists — do NOT do invasive rewiring), compare the provided `files` list against this run's in-scope dirty files after the commit. If files remain, append to the tool's success summary: `Warning: N in-scope files from this run are still uncommitted: <list>`. **Never auto-stage files the caller didn't list** — pre-existing WIP files from other agents may be dirty in the same tree, and silently staging them is worse than the bug. If the plumbing has no clean path, skip this fix and say so in the report; FIX 1-3 provide the enforcement.

### Tests (required)

Follow the existing test setup under `src/agent/__tests__/` (same framework/runner as `systemPrompt.test.ts`):
- `runContext === undefined` + changed files → commit required; + `metadata.requireCommit === false` → not required.
- `runContext` present without commit flags → NOT required (pipeline regression guard).
- Repair loop: still-dirty manifest after first repair → second reminder fires; after cap → report carries the `COMMIT INCOMPLETE` block.
- Reminder text includes the untracked-files line.

### Verify

1. `npm run build` exits 0 (npm-linked — the built dist is live immediately).
2. Full test suite green (`npm test` or the repo's script).
3. Manual E2E: in a throwaway git repo, run a non-interactive `tanya` prompt that (a) edits one tracked file and (b) creates one NEW file, with NO mention of committing in the prompt. Assert: HEAD advanced, `git status --porcelain` is clean, and the commit contains BOTH files.

**COMMIT (do not skip — this is the very failure mode you are fixing): from the tanya repo root, `git add` exactly the source/test files you touched (path-limited, never `git add -A`) and commit with message `fix(agent): commit gate defaults on for ad-hoc runs; re-arming repair loop; untracked-file reminder`. Then run `git status --porcelain` one final time — if anything you touched is still dirty or untracked, add it to the commit with `--amend` before reporting done.**

--- END PROMPT ---
