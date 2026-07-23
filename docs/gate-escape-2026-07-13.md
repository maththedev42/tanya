# Gate-escape forensics — 2026-07-13

The quality gates released as **0.17.1-beta.9** (`ab8284f..e2c6be9`, 2026-07-13 19:35) were
reproduced-through the very next runs (CosmoKit 20:10–21:57, appcreator hosting 21:48–21:50).
This is the root-cause analysis for each escape (E1–E8) and the fix that closes it.

Every escape traces to **one structural fact plus two smaller holes**. The stale-binary
hypothesis (c) was *eliminated* before this analysis: `/opt/homebrew/bin/tanya` → npm-link →
this repo, `dist/` built 19:34:58 (the beta.9 build), and the gate identifiers are present in
the shipped chunks. **The gates were live during every escaped run.**

---

## The one structural cause: `interactive: true` disarms every gate

The mac app (and any `tanya serve` client) drives runs through `src/cli/serveStdio.ts`, which
calls `runAgent({ …, interactive: true })` on **every** turn (serveStdio.ts:245). In
`buildFinalManifest` and the runner's finalize paths, *every hard gate and the FAILED verdict
itself* are guarded by `!interactive`:

| Gate | Guard (before fix) | File |
|---|---|---|
| verify-gate | `if (!params.interactive && …)` | report.ts:351 |
| commit-completeness | `if (!params.interactive && commitRequiredForRun(…))` | report.ts:372 |
| clean-tree build | `headMoved = !params.interactive && …` | report.ts:389 |
| coding report + verdict | `emitCodingReport = isCodingTask && !interactive` | runner.ts:2764 |
| clean / dup-skip / stall final message | `if (interactive) { softWarning } else { report }` | runner.ts:2252, 2694, 2780 |

So a task submitted through the mac app gets **only** a soft `interactiveCommitWarning` line —
no verify-gate, no commit-completeness, no clean-tree, no spec-coverage, no `TANYA RESULT: FAIL`.
The gates were built and unit-tested for the non-interactive `tanya run` / pipeline path. The
user's actual daily driver runs everything `interactive: true`, which is the *only* mode none of
them fire in.

Corroboration: interactive runs do **not** write a top-level `.tanya/runs/*` archive. The
appcreator hosting run (E6/E7) left archives only for its non-interactive *subtasks*
(`r-mrjqkw93-73d035b0.t-1.t-1`, `.t-1.t-2` — both "tool-turn limit reached", `changedFiles`
near-empty); the top-level run that produced commits `f202e5f`…`58ca815` left no archive at all.
That is the signature of an interactive parent spawning non-interactive children.

**`interactive` is a transport flag, not an intent flag.** A pasted engineering task ("# FIX-01
… 10 numbered items … ## Verify: `xcodebuild` … commit each item") is treated identically to
"what's the capital of France?". The fix is to gate on *intent* — a coding task that changed
files or carries task structure — regardless of the transport.

---

## Per-escape classification

Legend for the required distinction: **[never-executed]** gate code did not run •
**[passed-wrongly]** ran but returned OK • **[nudged-ignored]** produced a signal that didn't
gate • **[stale-binary]** old code (eliminated).

### E1 — deliverable uncommitted, dependency untracked, no failure — [never-executed]
`GettingStartedView.swift` (committed earlier) references `GettingStartedManager.swift` (left
untracked) for three consecutive runs; `git worktree add HEAD && xcodebuild` → BUILD FAILED.
The commit-completeness gate (`bcc1cfc`) and clean-tree check (`4270349`) both existed. Neither
ran: `interactive: true`. The runs ended via the stall / turn-budget path *and* the interactive
guard — both disarm the gate, so "whether or not it reached a commit step" is exactly the hole.
**Fix:** FIX-A (below). A coding task that wrote files is gated on the stall path too, because
`buildFinalManifest` already runs on all four finalize paths — only the `!interactive` guard was
suppressing it.

### E2 — ~20 missing locale keys, twice — [nudged-ignored] (+ latent verdict hole)
The localization validator (`localizationParityValidator`, staticChecks.ts) **already** extracts
keys from the source diff (`L10n.tr`, `NSLocalizedString`, `R.string.x`) and flags keys missing
from *every* locale file — the prompt's hypothesis ("only compares locale files to each other")
was wrong for the current code. It escaped for two compounding reasons:
1. It runs under `isCodingTask` (not `!interactive`), so it *executed*, set
   `validation.passed = false`, and drove the repair loop — but the interactive final-message
   path emits the soft warning, never the FAILED verdict.
2. **A latent hole affecting non-interactive runs too:** `manifestVerdict` fails only on
   `manifest.blockers`; validator ERRORs are merged into the verdict set only for *subtask*
   verdicts (runner.ts:1408) and the footer's display `blocked` — never into the top-level
   `manifest.blockers`. So the badge reads PASSED while the footer says "Gate results: FAILED".
**Fix:** FIX-A (surface for interactive) + FIX-E (validator ERRORs → `manifest.blockers` before
the verdict) + FIX-B (widen extraction to `L10n.format`, `String(localized:)`).

### E3 — ~40% of numbered items unfinished, passed — [never-executed]
The spec-coverage gate (`c0550f5`) lives in `ensureCodingReport`, which the runner only calls
when `emitCodingReport = isCodingTask && !interactive`. Interactive → never called →
`assessCoverage` never ran → dropped items (5,6,7,8,10) never surfaced. A dropped item is not
mentioned in the report, so it would have been `pending` → blocker → FAIL, had the gate run.
Item 7 (mentioned but stubbed with an empty `if`) is the residual weakness the coverage text-match
can't see — addressed as a nudge by FIX-C, not by coverage.
**Fix:** FIX-A makes coverage run for interactive tasks.

### E4 — empty-`if` stub, constant-default field, deleted `track` call — [never-executed]
No detector existed for these three shapes. The reachability validators covered no-op handlers,
dead enum cases, dead Go exports, and external-fact assumptions — none of the three E4 shapes.
**Fix:** FIX-C adds three WARNING-tier detectors.

### E5 — batch/queue truncation invisible — **user-workflow, not a gate hole**
There is no queue/batch primitive inside Tanya. Each pasted prompt (FIX-01, FIX-02, …) is a
separate `startTurn` in serveStdio — a separate paste by the user. FIX-02/FIX-03 "leaving no
trace" means those turns were most likely never submitted (or were interrupted by the next paste
before finalizing), not that Tanya received and silently dropped them. There is nothing for a
report to enumerate across independent turns. **The within-a-single-run analogue — a numbered
item dropped inside one prompt — is exactly what spec-coverage covers, and FIX-A makes it run.**
Cross-prompt batching, if wanted, is a new feature (a real queue with a persistent ledger), out
of scope here and called out as such.

### E6 — committed run still broke HEAD (Go) — [never-executed]
Same root cause as E1, in a different repo/language and *with* commits. `f202e5f` (21:48)
committed only `router.go` + `httpx/router.go` (route registration to `rd.PostDetectHosting`
etc.); the handler bodies (`reads/database_handler.go`, the `PostDetectHosting` hunk in
`reads/handlers.go`) landed the *next day* in `7118f3d`. So at commit time `go build ./...` →
`rd.PostDetectHosting undefined`. Committing does not save it: the top-level run was interactive,
so commit-completeness ("every file this run wrote is committed") and clean-tree ("HEAD compiles
from a fresh checkout") were both disarmed by `interactive: true`. The gates check the right
thing — they just didn't run. **Fix:** FIX-A gates interactive tasks; commit-completeness names
the untracked `database_handler.go`, and clean-tree (opt-in) catches the non-compiling HEAD.

### E7 — ordered-item truncation, repeat offenders, invisible — [never-executed] (+ missing feature)
Same never-ran cause as E3. Additionally, items 6/7 have been dropped across four prompts in
three days with nothing flagging the recurrence. **Fix:** FIX-A runs coverage; FIX-D adds a
persisted per-run coverage history so an item that was `pending`/`skipped` in a recent prior run
is marked `⚠ repeat-offense` in the table — the highest-signal items a run must not drop.

### E8 — tree not compiling, mandated verify never run — [never-executed]
The FIX2-01 Verification Contract's step 1 is a plain `xcodebuild` that fails in seconds
(`SimulatorDevice.init` gained a required `isAvailable:` param; the two call sites in
`SimulatorAppsService.swift` were never updated). The verify-gate (`d6be460`) parses
`## Verify` commands and blocks on any without passing evidence — but it is guarded by
`!interactive`, so it never parsed the contract. **Fix:** FIX-A arms the verify-gate for
interactive tasks; `unexecutedVerifyCommands` then lists `xcodebuild` as unexecuted → blocker → FAIL.

---

## Forensic gap found: gates don't log their own verdicts

There is no record of *which gates armed and how they voted* — the only persisted artifact is the
run archive (which interactive runs don't even write). That is itself a finding. FIX-A adds a
`gateLog` breadcrumb array to the manifest (armed/skipped + fired, per gate), so it is always
present in the manifest JSON and the deterministic footer — the next forensic starts from data,
not inference.

---

## Fixes

- **FIX-A — intent-gated, not transport-gated (E1/E3/E6/E7/E8, and E2 surfacing).**
  New `src/agent/taskGating.ts`: `interactiveTaskGatesArmed({interactive, runContext, changed,
  prompt})` = interactive **and** not opted-out **and** (`promptHasTaskShape(prompt)` — ≥2 numbered
  deliverables or a `## Verify` section — **or** a coding run that changed files). Every
  `!interactive` guard on the hard gates and on `emitCodingReport` becomes `!interactive ||
  interactiveTaskGatesArmed(…)`. A plain chat turn (no task shape, no coding changes) still gets the
  soft path — a working app is never false-failed. Opt-out: `TANYA_TASK_GATES=off` or
  `runContext.metadata.taskGates === false`. Interactive reports render **concise** (no raw JSON
  manifest dump) so the mac-app transcript stays readable.
- **FIX-B — widen localization extraction (E2).** Add `L10n.format("…")`, `String(localized: "…")`.
- **FIX-C — three reachability detectors (E4), WARNING tier.** empty conditional body (comment-only);
  constant-default field never assigned elsewhere; a `track`/analytics emit present before a rewrite
  and absent after.
- **FIX-D — repeat-offense coverage (E7).** Persist per-run coverage to
  `.tanya/spec-coverage-history.json`; mark an item `repeat-offense` when it was unfinished in a
  recent prior run.
- **FIX-E — validator ERRORs flip the verdict (E2, general).** In `ensureCodingReport`, push
  error-severity validation issues into `manifest.blockers` before `manifestVerdict`, so the badge
  and the "Gate results / Blocked" lines can never disagree.

All objective gaps (E1/E2/E3/E6/E8) are hard-fail tier, default ON for any task run (interactive or
not); heuristics (E4) stay nudge tier. Regression tests reproduce each escape from the real shapes.

---

## LANDED — 2026-07-14 (0.17.1-beta.10 → beta.11)

The fix shipped in `2dfb044` (release `5043a19`, beta.10) and was then proven live and hardened
(beta.11). Escape → fix → regression test:

| Escape | Closed by | Regression test |
|---|---|---|
| E1 (uncommitted/untracked deliverable) | FIX-A intent gating + `--untracked-files=all` in `dirtyPathsInRepo` | `commitCompleteness.test.ts` "E1: FIRES for an interactive TASK-SHAPED run…"; `gateCanary.test.ts` |
| E2 (missing locale keys / badge lied) | FIX-A + FIX-E gating-`ValidationIssue` + wider extraction | `reportHonesty.test.ts` "FIX-E — a validator ERROR flips the verdict"; `staticChecks.test.ts` "FIX-B" |
| E3 (dropped numbered items) | FIX-A (spec-coverage now runs interactive) | `gateCanary.test.ts` (Part 3 pending); `specCoverage.test.ts` |
| E4 (empty-if / dead field / deleted track) | three nudge detectors | `reachabilityChecks.test.ts` (emptyConditionalStub / constantField / deletedAnalytics) |
| E5 (queue truncation) | user-workflow, not a gate hole — documented, no code | n/a |
| E6 (committed tree didn't build) | FIX-A commit-completeness interactive + clean-tree | `commitCompleteness.test.ts`; `cleanTreeBuild.test.ts` |
| E7 (repeat-offense items) | `specHistory.ts` repeat-offense marking | `specHistory.test.ts` |
| E8 (mandated verify unrun) | FIX-A verify-gate interactive | `verifyGate.test.ts` "E8: FIRES for an interactive TASK run…"; `gateCanary.test.ts` |

### Corrections to this doc's original claims
- **"Interactive runs write no top-level `.tanya/runs/*` archive" was WRONG.** `finishRun` calls
  `logRunSummarySilently` unconditionally, so interactive runs DO archive — but to the **serve cwd**
  (the workspace root the mac app passes with `--cwd`), NOT the nested target repo where the git
  changes happen. That is why the forensic looked in `appcreator/.tanya/runs` / `CosmoKit/.tanya/runs`
  and found only subtasks: the top-level record was in `Appzinhos/.tanya/runs`. beta.11 adds
  `verdict` + `gateLog` to that record so the outcome is readable straight from the archive.

### Proven live (the acceptance criterion that never existed)
`gateCanary.test.ts` drives the real interactive path against a gate-violating task and asserts a FAIL
verdict naming the uncommitted file, the dropped deliverable, and the unrun verify command. See
`docs/gate-canary-2026-07-14.md`. It caught a genuine bug (new-directory untracked files collapsed by
`git status`), now fixed.

### beta.11 also closes the test-target verification gap (CosmoKit FIX3, `c7bf7b9`)
A run can honestly pass `xcodebuild … build` and still ship a commit whose **test target** doesn't
compile (a library signature changed; its test call sites went stale — plain `build` never compiles
tests). The clean-tree gate now upgrades its build to compile tests without running them
(`xcodebuild build-for-testing`; `go build ./… && go test -run '^$' ./…`), opt-out via
`compileTests: false`. Regression: `cleanTreeBuild.test.ts` "test-target compilation (CosmoKit FIX3
shape)" — plain `go build` passes, the upgraded build FAILs on the stale test call site.
