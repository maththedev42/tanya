# Changelog

## [0.17.1-beta.36] - 2026-07-22

### Waves R1c–R3b + CodeWhale ports — flags, holds, snapshots, ledger, stuck guard

- **Typed runtime flags (R1c):** `config/runtimeFlags.ts` is the one
  typed surface for ~60 behavioral `TANYA_*` flags; `.env.example` is
  generated from the registry and a test pins it (drift fails CI).
  Agent-core call sites migrated onto the shared parser primitives.
- **Protected-path write holds (P1-A):** `.tanya/protect.json` declares
  paths no run may write; enforced in the tool gate before execution.
  Rules only tighten, failures degrade to zero holds, `ask` fails
  closed — no permission mode skips a hold. Decisions breadcrumb into
  `manifest.gateLog`.
- **Compaction unified (R2a):** one clear→micro→snip ladder for the
  proactive and reactive paths; reactive LLM auto tier unchanged.
- **report.ts split (R2b):** verification-recovery classifier and
  artifact-reuse munging extracted to their own modules; the
  3,484-line final-report test sharded into four parallel files.
- **Swift event drift killed (R2c):** `ServerEvent.swift` knownTypes is
  generated from the union's `SERVER_EVENT_TYPES`; a test pins the
  file. Fixes the live "provider_raw" vs "provider.raw" mismatch.
- **CLI registry (R2d):** self-contained subcommands dispatch through
  `cli/processCommands.ts`; `main()`'s ~300-line if-chain is gone.
- **Turn snapshots + `tanya restore` (P2-A):** side-repo snapshot of
  the touched repo before a turn's first mutating tool; `tanya restore
  [--list|--to <id>]` undoes a turn (nested-repo aware, .gitignore
  honored, never touches the user's .git, 50-cap/7-day prune).
- **Run-step ledger (P2-B core):** append-only `.tanya/ledger.jsonl`
  records commits and verification outcomes live; recovery preambles
  now carry a LEDGER DIGEST ("already committed / verified green /
  still red") so continuation runs resume instead of re-auditing.
- **Unified StuckGuard (R3b):** failure fingerprints with
  error-signature folding catch re-spelled identical failures and A/B
  loops; warn once, then the standard wrap-up window. Never fails a
  green run.
- Opt-outs: TANYA_SNAPSHOTS / TANYA_STUCK_GUARD / TANYA_DRIFT_GUARD
  (all =off). Suite: 1,580 tests green.

## [0.17.1-beta.35] - 2026-07-22

### Wave R1a+R1b — run lifecycle unification + tools reorganization

- External-backend runs (`tanya run --backend ...`) now record the same
  memory side-effects as native runs — golden-task memory, task history,
  obsidian notes, repair memory — via the new shared
  `agent/runLifecycle.ts`. They previously skipped all four silently.
- One run-archive writer for native and external runs. External archives
  now carry the top-level verdict/blockers/changedFiles/gates fields the
  doctor's forensics read (they were nested under `manifest`, invisible
  to diagnosis), plus binary identity, rotation, and archive pointers.
- The native runner's three duplicated finalize tails collapsed into one
  `finalizeRun`; deleted the dead `_recoveryPreflightDone` write.
- Task ledger writes `.tanya/plan.json` (was still writing the
  pre-rebrand `.tania/`, recreating the legacy dir after migration);
  legacy location remains readable.
- `fsTools.ts` split: validator tools → `fsValidators.ts`, platform
  scaffold tools → `platformScaffold.ts` (~1090 lines out, zero shared
  state); shell-output enrichment is one `enrichShellOutput()` pipeline.
- New `tools/toolGate.ts` choke point: every write-capable tool call
  crosses `evaluateToolGate` in `ToolRegistry.run` before executing.
  Policy-free today; it over-collects normalized write targets (param
  shapes + unified-diff headers incl. deletions) so protected-path
  write-hold rules can land as a pure drop-in.
- Behavior-preserving throughout (except the external-run fixes above);
  full suite 1537 green.

## [0.17.1-beta.34] - 2026-07-21

### Read-only drift guard — receive the task and DO it

- Failure class (observed 2026-07-21): coding runs burned 2.6M and 2.1M
  prompt tokens over 30+ tool calls with ZERO file edits, then finalized
  as soft PASSes — reading a new file counts as progress, so no stall
  stop ever fired, and gates never arm on a zero-change run. The model's
  own last words: "I spent the whole run just reading files and never
  wrote a single line of code."
- Guard (coding-classified runs only; chat/explain turns never nudged):
  zero mutations by turn 8 → "make the FIRST real edit this turn, or say
  NEEDS USER"; turn 16 → final warning; turn 24 → the run is closed via
  the wrap-up window with a mandatory honest report (what was learned,
  the exact edits that WOULD be made, why nothing was written).
- Disarmed permanently by the first successful file mutation — verify
  phases and failing-build loops after an edit are never nudged.
  Opt-out: TANYA_DRIFT_GUARD=off.

## [0.17.1-beta.33] - 2026-07-20

### Recovery preamble no longer creates phantom gate requirements

- Root cause of the r-mrtlzbyi false FAIL: the recovery preflight embeds
  the doctor's repair prescription (which contains `### Part 1/2/3`
  headings) into the dispatched prompt, and every gate that parses "the
  prompt" for task semantics saw the mutated prompt — so a run that did
  everything green FAILed on "Part 2, Part 3" that existed only inside
  the prescription.
- New `recoveryPrompt.ts`: shared `prependRecoveryBlock` (both runners)
  + `stripRecoveryPreamble`. Spec-coverage, verify-command extraction,
  commit-intent, additive-edit shape, runtime DoD, final-state verify,
  deferral citations, and task-shape arming now all see the user's
  ORIGINAL task only.
- Also fixes gate arming on plain chat turns after a FAIL: the recovery
  block's structured contract no longer makes a conversational turn look
  task-shaped.

## [0.17.1-beta.32] - 2026-07-20

### Graceful budget exhaustion — wrap-up window instead of silent death

- When the no-progress stop or the token-runaway backstop trips, the run
  no longer breaks silently: a fixed 4-turn wrap-up window opens with an
  injected directive — commit completed work path-limited, write the
  final report, start nothing new. The deadline is hard: progress made
  during wrap-up (commits count as progress) never extends it.
- Case study (2026-07-20): a repair task needed 4 runs and 3 budget
  deaths to land work that was finished in the tree after run 1 — it was
  never committed because the run died without warning.
- Stall final messages now note when a wrap-up window was granted.

### Recovery brake — non-converging recovery loops stop grinding

- `LAST_RUN_FAILED.md` records `recoveryAttempts: N` when the failed run
  was itself a recovery run (native + external runners).
- A 3rd consecutive recovery attempt gets a commit-and-stop contract
  instead of the full task: confirm state, commit green work, report
  remaining gaps, end with `NEEDS USER` — the doctor and the original
  task text are skipped entirely.

### Recovery preamble is now progress-preserving

- The RECOVERY contract no longer frames leftover work as damage or
  demands a full audit before the task. New order: cheap state check →
  commit finished work FIRST → smallest fix if broken → resume the task
  from what remains, never re-auditing parts already done and committed.

## [0.17.1-beta.31] - 2026-07-20

### Doctor ledger + escalation (self-heal 02)

- Recurrence ledger: `.tanya/doctor/ledger.jsonl` per workspace, one line
  per doctored run with normalized signature fingerprint.
- Escalation: unknown-class signature appearing ≥2 times → improvement
  draft (`.tanya/doctor/improvement-<slug>.md`); known class ≥3 times in
  7 days → nag line in diagnosis.
- `tanya doctor --list` prints ledger summary (class counts, recent
  signatures, pending drafts).
- Malformed ledger lines are skipped without crashing.

### Orchestra subagent lifecycle events (ORCH-03)

- `subagentJobManager` emits lifecycle events: dispatched, started,
  progress (throttled), completed, cancelled.
- Serve stdio forwards events to connected clients; CLI renders compact
  lines (observational only — never touches verdicts).

### Orchestra strip in the mac app (ORCH-04)

- Collapsible orchestra strip above the transcript: conductor card + worker
  cards (keyed by jobId) with status chips, live tail, and cancel button.
- Cancel wired through `ClientMessage.cancelSubagent`; collapse state
  persists per session.
- Fixed `ClientMessage.CodingKeys` missing `jobId` case.

## [0.17.1-beta.30] - 2026-07-20

### CLI-strict routing tests (ORCH-01 Part 2 & Tests)

- Resolution matrix tested: provider × CLI available × via flag → route.
  46 unit tests cover claude/cursor/codex/kimi auto-inference, --via
  escape hatches, explicit --backend, and deepseek/other non-CLI-strict
  providers always routing API.
- API key irrelevance tests document: resolveRunRoute does not accept
  an API key parameter — CLI presence alone determines routing.
- `tanya providers list --json` now asserts route/routeLabel fields
  for every provider; non-CLI-strict providers (deepseek, openai) always
  report route=api.

## [0.17.1-beta.29] - 2026-07-19

### GNU flags on BSD tools get a recipe instead of a mystery failure

Live stall (03c run): `sed -n '403,407p' … | cat -A` exits 1 on macOS —
`cat -A` is GNU coreutils; Darwin's stock userland is BSD (`cat: illegal
option -- A`). The bare exit-1 read as an inexplicable failure and was
retried verbatim to the stall backstop. Now `run_shell`/`run_command`
results that carry the BSD tools' own rejection wording (`illegal option
-- X`, or `` unrecognized option `--x' `` with BSD's backtick quoting)
get an instructive block PREPENDED: names the tool and flag, states
"macOS ships BSD userland, do NOT retry the same command", and gives the
exact BSD replacement for the tools we mapped (`cat -A`→`cat -evt`,
`date -d`→`date -v`/`date -j -f`, `stat --format`→`stat -f`,
`du --max-depth`→`du -d`, plus a `sed -i ''` note), falling back to
"check `man <tool>`" for unmapped ones. Keyed ONLY on the tool's own
error output — never the command text — so it cannot false-fire; GNU
getopt spells these errors differently ("invalid option", straight
quotes), verified against live captures. Result stays `ok: false` (the
probe did not answer its question); the original error remains visible
after the guidance. Note: modern macOS `grep -P` and `ls --color`
actually work — deliberately NOT flagged (probed before mapping).

Also: `RunRouteInput.via` (ORCH-01, committed by a Tanya run in
`c9ceb98`/`98c1081`) failed `tsc --noEmit` under
`exactOptionalPropertyTypes` — the run stalled before its Verify step
ran. Widened to `string | undefined` (the documented contract); her 34
runRoute tests pass unchanged.

## [0.17.1-beta.28] - 2026-07-19

### Post-gate recovery: repair before FAIL, and never end silently on a known FAIL (PROMPT B5 items 2 + 4)

The gates now detect correctly in the field (run 5: commit gate named
project.yml, the validator caught `Purchases.logLevel` with rationale, the
build gate carried exit 65, spec-coverage demanded Parts 1–3) — but the
run finalized ON TOP of the FAIL and handed back a broken tree. Root
cause, verified on the archives: all three failed field runs show
`repairAttemptCount: 0`. The bounded repair loop has existed since the
validation-repair work — reminder with blockers verbatim (which since
beta.26 carry the extracted build-error lines), per-issue repair hints,
signature dedup, configurable budget (`--repair-attempts`, ≤5) — and its
TRIGGER already accepted interactive task-shaped runs, but
`repairAttemptBudget` still returned 0 unless `isCodingTask(runContext)`,
so for every mac-app dispatch the condition was `0 < 0`. The budget now
arms for interactive task-shaped runs too (same predicate the gates use),
evaluated lazily at the repair trigger because interactive arming depends
on live run state. Defaults unchanged: 3 (TypeScript workspace) / 2,
explicit configuration still wins.

Second half of the contract: a run that still FINALIZES with blockers —
budget exhausted, or stall/turn-budget exit — now writes a structured
`.tanya/LAST_RUN_FAILED.md` (blockers verbatim, files touched,
still-uncommitted list, repair attempts used, `tanya doctor --run <id>`
pointer) at both the native finishRun seam and the external-backend
finalize. A later finalize that PASSES with gates armed clears the
marker; unarmed conversational turns never touch it. Complements the
beta.21/25 sentinel (which covers dirty/hard-death exits) — between the
two, no ending leaves the tree silently broken.

### Additive-edit guard (B5 item 4)

Instrumentation/telemetry tasks are add-only by nature; run 5's analytics
edits silently deleted the register/Apple `errorMessage` handling and the
Google session cleanup in AuthStore. When the prompt is
instrumentation-shaped (analytics/telemetry/telemetria/instrumentar/
tracking/GA4/PostHog/Firebase Analytics/funnel/funil), the final manifest
now diffs the run's touched files against the pre-run head and surfaces
every removed non-whitespace line as a NUDGE — "restore each removed line
or justify the removal in the report" — never a blocker, because some
removals are legitimate.

B5 item 1 (fix cli.ts, commit the doctor work) shipped as beta.27. Item 3
was already implemented in beta.25/26 (`swift-escaped-string-interpolation`
error + `swift-escaped-keypath` warning); this release only adds the
`\\(row.title)` property-access field shape as a regression test. Item 5
(freshness over deletions, xcodegen rename nudge, `tanya doctor
--sentinel`, claim-evidence anchors) is NOT in this release.

## [0.17.1-beta.27] - 2026-07-19

### `tanya doctor` — failed runs self-diagnose and draft their own repair prompt

`tanya doctor [--run <id>] [--cwd <dir>]` reads the most recent non-PASSED
run archive (following `.at` pointer files, by mtime — serve-cwd runs
archive at the serve workspace and leave only pointers in touched repos),
plus the `LAST_RUN_FAILED.md` / dead-pid `RUN_IN_PROGRESS.md` markers, and
classifies the failure against a catalog seeded from the classes hit live
in beta.21–beta.26: `dead-run-dirty-tree`, `stall-blind-build`,
`commit-incomplete`, `verification-stale`, `spec-gap`,
`subagent-child-failed`, `mangled-edit`, `unsupported-deferral` — or an
honest `unknown` (never invents a classification). It writes
`.tanya/doctor/<runId>.md` (diagnosis with evidence quotes) and
`.tanya/doctor/<runId>-repair-prompt.md` (a dispatchable repair prompt);
it never runs the repair itself. Read-only over the target repo: the
mangled-edit scan reuses the real DEFAULT_FORBIDDEN_PATTERNS catalog (one
source of truth with the run gates) but never records fire metrics. With
nothing to diagnose it says so, writes nothing, and falls through to the
legacy setup checks (which also remain behind `--json` and as the
unknown-class fallback).

Every FAIL report now ends with `Doctor: run \`tanya doctor --run <id>\`…`
— appended in ensureCodingReport, the report-building seam shared by the
native runner and the external-backend path, so the pointer appears for
every entrypoint. Informational only: it never touches blockers or the
verdict. TanyaFinalManifest gains an optional `runId` to carry the id to
that seam.

Base implementation by a Tanya run (r-mrs0wd55 + continuations); this
release also repairs what those runs left broken: `src/cli.ts` had a
duplicated legacy-doctor body pasted inside the new command (3 tsc
errors — the tree did not compile), the hand-rolled mini pattern list
flagged CORRECT Swift interpolation `\(name)` as mangled (replaced with
the shared catalog), discovery ignored `.at` pointers and sorted by
runId string instead of mtime, changedFiles resolution missed
workspace-relative paths from pointer archives, a healthy repo got a
bogus `unknown` diagnosis written into `.tanya/doctor/`, and the FAIL
footer lived in one runner path instead of the shared seam.

## [0.17.1-beta.26] - 2026-07-19

### Failing build logs must lead with their error lines

Observed live (FinanceWorld F1 run): `xcodebuild` failed with exit 65 and
three syntax errors in BillsView.swift — but the megabyte log defeated the
model-facing head+tail truncation: the `error:` lines sat in the dropped
middle, the model saw only "Command exited 65. Output was truncated…" plus
compile spam, and re-ran the identical build until the stall backstop.

- **feat(shell): `keyErrorLinesBlock`.** Any non-ok `run_shell`/
  `run_command` result whose output exceeds 16k chars now PREPENDS a
  "## Key error lines" section — up to 40 deduped lines matching
  `error:`/`fatal error:`/`error TS…`/`** BUILD FAILED **`/`FAILURE:`/
  `Testing failed:` (xcodebuild repeats each error, hence dedupe) — so
  every downstream truncation window keeps the reasons, not just the exit
  code. The `error` field leads with them too. Small or successful outputs
  are untouched.
- **feat(validate): `swift-escaped-keypath`.** Sibling of
  `swift-escaped-string-interpolation` for KEY PATHS: a parenthesized
  `(\\.name)` with two literal backslashes (the agent/JSON over-escape,
  e.g. `@Environment(\\.modelContext)`) does not compile — "expected
  expression path in Swift key path" broke the live run. WARNING severity
  (a string literal can legitimately contain the shape); message says to
  write the single-backslash form.
- **test:** 4 extraction tests (buried error surfaces in the head window,
  dedupe, success/small untouched, TS+gradle shapes) + 3 keypath pattern
  tests. Full suite 1363 green.

## [0.17.1-beta.25] - 2026-07-19

### Gates cover every execution mode — sentinel placement, kill -9, external backends

PROMPT B3, from the FinanceWorld "run 3" audit ("beta.21 was installed and
nothing fired"). Forensic correction first: run 3 executed through the
instrumented runner but on the PRE-sentinel dist (beta.21 was committed,
dist rebuilt only later), and its artifacts landed in the serve cwd
(`Appzinhos/.tanya/runs`) — invisible from `FinanceWorld/.tanya`, where the
audit looked. Two genuine holes existed and are closed:

- **feat(sentinel): placement follows the TARGET repos.** The
  `LAST_RUN_FAILED.md` marker + a `runArchivePointer` `.at` stamp now land
  in EACH repo the run touched (sync signal-safe repo resolution, per-repo
  hazard evaluation); the aborted archive stays at the session workspace.
- **feat(sentinel): kill -9 heartbeat.** `.tanya/RUN_IN_PROGRESS.md`
  (runId, pid, changed-so-far) flushed into each touched repo on the first
  mutating tool result and every N after (`TANYA_SENTINEL_FLUSH_EVERY`,
  default 8); every graceful end removes it — a surviving heartbeat with a
  dead pid IS the death marker.
- **feat(sentinel): external backends armed.** `tanya run --backend` was
  the one entrypoint with no sentinel: now wrapped like runAgent
  (exception + signal → aborted archive; 30s timer heartbeat while the
  external CLI runs; archived returns supersede).
- **feat(validate): `swiftui-bare-accentcolor-shapestyle`.** Bare
  `.accentColor` inside `foregroundStyle(...)` is not a ShapeStyle member
  and broke two runs — flagged with "write `Color.accentColor`". WARNING
  severity by design: a project-level ShapeStyle extension can legalize
  the form, and a hard error could false-FAIL a green build (dodGate
  contract). Same-file extension suppression included.
- **feat(prompt): "State wired end-to-end" checklist rule** (both modes):
  every UI-written property (selections, overrides, toggles) must be READ
  by the execution path — if only the UI reads it, the feature is
  disconnected (run 3 wrote deselectedRowIDs/rowCategories/
  createInstallmentsForRowID and doImport ignored all three).
- **test:** per-entrypoint regression — nested-repo marker/pointer
  placement, interactive serve-turn dirty death, heartbeat lifecycle
  (flush/clear/supersede/cross-run safety), runner first-write flush,
  external-backend heartbeat, 5 accentColor cases. Suite 1356 green.

## [0.17.1-beta.24] - 2026-07-19

### CLI proxy + subagent orchestration (Tasks 01–03 of 06)

Tanya can now delegate tasks to external coding CLIs (`claude`, `codex`,
`cursor-agent`) under its own verdict gates, and orchestrating models
can dispatch parallel Tanya subagents via tools — the proxy gates and
subagent control plane are complete; the `orchestrate` command and MCP
async job tools (Tasks 04–05) remain for a follow-up series.

**Proxy (Tasks 01–02):**
- **feat(proxy):** `src/executors/` — CLI executor pluggable backends for
  `claude` (Claude Code), `codex` (OpenAI Codex CLI), and `cursor-agent`.
  Each executor wraps the CLI's own login (no API keys); child env is
  stripped of `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`CURSOR_API_KEY` and
  their `_BASE_URL` variants. `tanya run --backend <name>` delegates the
  whole agent loop; Tanya snapshots git before, runs the external CLI,
  then feeds its output through the full finalize gate stack (verification
  freshness, commit gate, spec coverage, validators, deterministic report).
  The archive carries a `backend` field. Capability detection degrades
  gracefully when a CLI binary is absent.
- **test:** executor unit tests (claude/codex/cursor mock spawns, env
  hygiene) in `src/executors/__tests__/executors.test.ts`.

**Subagent orchestration (Task 03):**
- **feat(orchestra):** `src/tools/subagentTools.ts` — four tools
  (`dispatch_subagent`, `subagent_status`, `subagent_result`,
  `subagent_cancel`) running through `SubAgentJobManager`
  (`src/tools/subagentJobManager.ts`). Workers share a bounded
  concurrency pool (`TANYA_SUBAGENT_CONCURRENCY`, default 3). A depth guard
  rejects dispatch when `parentContext` is already present (≤1
  recursion).
- **feat(orchestra):** `childVerdicts` integration — any consumed child
  FAIL flips the parent's verdict to FAIL. The deterministic report
  footer lists one line per child (label, backend, verdict, runId).
  Structured report carries the full `childVerdicts` array.
- **feat(prompt):** 10-line orchestrator block in `systemPrompt.ts`
  (2 lines in lite mode), present only when subagent tools are enabled.
- **test:** `src/agent/__tests__/subagentTools.test.ts` — 15 test cases:
  roundtrip, concurrency queueing, depth guard, cancel, FAIL→parent
  FAIL, external backend via fake executor.

**Skipped in this release (planned for follow-up):**
- `tanya orchestrate` command (Task 04) — orchestrator persona loop.
- MCP async job control tools (Task 05) — `tanya.dispatch`/`job_status`/
  `job_result`/`job_cancel`.
- Live proxy/orchestra drills (Task 06 E2E) — the sandboxed agent cannot
  mutate outside the workspace to create scratch git repos; re-run
  commands are listed in the task report.

## [0.17.1-beta.23] - 2026-07-18

### Missing-path probes are answers — ls/stat "No such file" stops stalling runs

Observed live (same session as the beta.22 stall): a run verified a cleanup
with `ls -la <dir>/ 2>&1`, got exit 1 + "No such file or directory" — which
PROVED the cleanup had worked — read it as a failure, and re-probed until
the stall backstop paused the run. Same disease as the beta.13 grep
no-match class: a probe whose nonzero exit IS the answer.

- **feat(shell): `missingPathProbeResult`.** A bare `ls`/`stat` invocation
  (one optional `cd` hop, trailing redirects stripped, no control
  operators) exiting 1 (BSD) or 2 (GNU) with "No such file or directory"
  now resolves ok with "Path does not exist — that IS this probe's answer…
  do not re-run the probe." Wired into both `run_shell` and `run_command`.
  Chained/piped invocations keep real exit semantics; ls errors without
  "No such file" stay failures.
- **refactor(shell):** extracted `hasUnquotedControlOperator` from
  `isBareSearchInvocation`, shared by both bare-invocation classifiers.
- **test:** 6 new tests in `runShell.test.ts` incl. the exact stalled
  shape end-to-end through both tools. Full suite 1329 green.

## [0.17.1-beta.22] - 2026-07-18

### The pipefail build-filter stall — grep's no-match exit 1 masked green builds

Recurring live stall: `set -o pipefail && xcodebuild … 2>&1 | grep -E
"error:" | head -40` exits 1 with NO output whenever grep matches nothing —
which is exactly what a CLEAN build produces (pipefail reports grep's
no-match 1; the upstream status is masked). The model read "Shell exited 1"
as a build failure and re-ran the identical command until the stall
backstop. Root irony: the masked-verification rule REQUIRES pipefail on
piped build commands, so Tanya's own guardrail manufactured the trap.

- **feat(shell): verdict-visible filter vet (`unsafeMaskedVerification`).**
  A pipefail'd mobile-build script with a `| grep …error…` filter and no
  success marker (succeeded/passed) is now rejected BEFORE running, with the
  fix in the message: `grep -E "error:|BUILD (SUCCEEDED|FAILED)"` or read
  the tail instead of filtering.
- **feat(shell): piped-grep no-match classifier
  (`pipedSearchNoMatchSummary`).** Any shell result with exit 1 + EMPTY
  output + a `| grep`-family segment now explains that the FILTER matched
  nothing and the upstream status is unknown, forbids retrying the same
  command, and gives the disambiguating recipe — instead of a bare "Shell
  exited 1". Never fires when output flowed (real errors keep real
  semantics); bare no-pipe searches keep the beta.13 "no matches" answer.
- **test:** 7 new tests in `runShell.test.ts`, incl. the exact FinanceWorld
  command shape blocked pre-execution and the clean-build shape explained.

## [0.17.1-beta.21] - 2026-07-18

### Gates cannot depend on reaching the end — exit sentinel + early nudges

The FinanceWorld T2/T3 run died mid-work: 6 new .swift files, ~20 compile
errors, zero builds — and because every gate armed at REPORT time, the death
left no archive, no marker, nothing. Items 1–2 make ANY termination leave a
trace; items 3–5 move build hygiene to WRITE time. Nothing here can false-FAIL
a legit green run (the sentinel is a no-op once the real archive lands).

- **feat(sentinel): exit sentinel (`exitSentinel.ts`).** `runAgent` is now a
  thin wrapper over `runAgentCore`; SIGINT/SIGTERM/SIGHUP handlers plus the
  wrapper's catch guarantee that success, stall, exception, or signal ALL end
  with an archive in `.tanya/runs/` — abnormal ends write a minimal
  `{aborted: true, terminationReason, changedFiles, uncommittedFiles,
  greenBuildObserved, verdict: FAIL}` record synchronously. `finishRun` flips
  `archived` so a completed run is never shadowed.
- **feat(sentinel): dirty-exit marker.** An abnormal end that leaves
  uncommitted files, or changed sources with no green build observed, also
  writes a loud `.tanya/LAST_RUN_FAILED.md` ("TREE MAY NOT COMPILE") naming
  the files and the termination reason. Safe deaths (green build, everything
  committed) get the archive but no marker.
- **feat(nudge): generator-aware new-file nudge (`projectGenerators.ts`).**
  A NEW source file landing in a generated-project repo (xcodegen via
  `project.yml`, tuist via `Project.swift` — small extensible table) draws an
  immediate tool-result nudge: the build will not see the file until
  `xcodegen generate` runs. Fires once per run; tracked-file edits never trip
  it.
- **feat(nudge): first-build-early.** More than N changed source files
  (default 3, `TANYA_FIRST_BUILD_NUDGE_AFTER`) with zero builds/tests run →
  one-shot nudge to compile NOW, not after 800 more lines.
- **feat(prompt): API-existence habit.** Both prompt modes now instruct:
  before calling a function/type/enum defined in another file, open that file
  and confirm the exact signature — never write cross-file calls from memory
  (the T2 run invented three cross-file APIs in one file).
- **test:** 10 new tests in `exitSentinel.test.ts` (incl. a full runAgent
  integration where the sink dies mid-finalize) and `earlyBuildNudges.test.ts`
  (nudges fire through real runAgent tool loops); systemPrompt assertions for
  the habit in both modes.

## [0.17.1-beta.20] - 2026-07-18

### Five gate reinforcements from the FinanceWorld S1+T1 forensic

A real run (2026-07-18) shipped a broken repo under a green report: it edited a
.swift file two hours AFTER the last green build, committed nothing, greened a
checklist item whose prerequisite prompt never ran, justified a deferral with a
fabricated scope quote, and left a stray fastlane/ scaffold. One reinforcement
per failure. Items 1–2 are hard gates (blockers); 3–5 are nudges and can never
flip a verdict — the dodGate false-FAIL contract holds throughout (suite green,
gate canary unweakened).

- **feat(gates): verification freshness (HARD, `verificationFreshness.ts`).**
  Every verification line is now timestamped (`verificationEvents`, runner.ts);
  at finalize, any changed SOURCE file whose mtime is newer than the last green
  authoritative build invalidates the evidence → `Stale build evidence: <files>`
  blocker. Fail-open: no green build event → skipped; a finalize-time
  authoritative pass (final-state verifier) clears it; docs/assets never trip
  it. Opt-out `metadata.freshnessGate === false`.
- **feat(gates): prompt-armed commit gate (HARD, `git.ts
  promptRequiresCommit`).** The prompt itself instructing a commit (en/pt,
  negation-aware: "do not commit" never arms) now arms the existing
  commit-completeness gate even for pipeline runContexts with no commit flags.
  `metadata.requireCommit === false` still opts out.
- **feat(gates): prerequisite honesty (nudge, `specCoverage.ts`).**
  Requirements whose own text gates them on ANOTHER prompt's deliverable
  ("requires T3", "if T3 has landed" — own-section refs excluded) can no longer
  self-certify as done: without report evidence that the prerequisite landed,
  a done claim is downgraded to skipped (never pending — cannot add a blocker),
  flagged in the coverage table, and a nudge forbids implementing another
  prompt's steps to green a checkbox.
- **feat(gates): deferral citations (nudge, `deferralCitations.ts`).** A
  deferral that QUOTES scope text not found in the prompt (the fabricated
  "Tier 3" shape), or claims scope exclusion without quoting the prompt at
  all, gets an `unsupported deferral` nudge. Honest operational skips ("no key
  available") are untouched.
- **feat(gates): artifact hygiene (nudge, `git.ts strayArtifactsSince`).**
  Dirty paths that APPEARED during the run but belong to no declared
  deliverable (subprocess scaffolds never enter the write-log, so the commit
  gate can't see them) → `stray artifacts: …` nudge; remove or justify.
- **feat(report): `manifest.reportNudges`** rendered as `Note:` lines in the
  deterministic footer; new archive sections `gates.verificationFreshness`,
  `gates.artifactHygiene`, `gates.deferralCitations`.
- **test:** 46 new/extended tests across `verificationFreshness.test.ts`,
  `prerequisiteHonesty.test.ts`, `deferralCitations.test.ts`,
  `artifactHygiene.test.ts`, `commitGate.test.ts` — incl. real-git
  integration through `buildFinalManifest` for both hard gates and both
  snapshot-diff nudges, and explicit never-blocks assertions for items 3–5.

## [0.17.1-beta.19] - 2026-07-18

### Provider/model picker — multi-provider support with footer UI

- **Claude + OpenAI adapters:** new `claude.ts` and `openai.ts` providers in
  `src/providers/adapters/`, registered alongside existing kimi/deepseek.
  Anthropic used via its OpenAI-compatible Messages endpoint. API keys from
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env vars with `TANYA_API_KEY`
  fallback.
- **Per-adapter model catalogs:** each adapter exports a `models` array;
  `tanya providers list --json` surfaces them. Pricing entries in
  `src/memory/runLogs.ts` for claude, openai, deepseek, kimi, grok, groq,
  ollama, qwen, together.
- **Footer provider/model picker menu:** the mac app's footer label is now a
  clickable `Menu` (dynamic from `ProviderSettings.providers`). Displays
  configured/unconfigured state per provider, model submenus, disabled while
  streaming. Pure `ProviderMenuModel.derive()` tested in isolation.
- **Inline key configuration sheet:** tapping an unconfigured provider opens
  a sheet with a key text field, "Test & Activate" button, Keychain
  persistence, and `SetupService.testProviderWithKey()`.
- **Switch-with-resume:** `ChatViewModel.switchProvider` stops the serve
  child, writes session metadata, and restarts with `--resume` so the
  transcript survives.
- **macOS tests:** `ProviderMenuModelTests`, `ProviderKeyConfigViewModelTests`,
  `ChatViewModelTests` (switch state machine).
- **Live probes:** DeepSeek live-probe passed. OpenAI, Claude, and Kimi
  skipped — env keys present but expired (HTTP 401 from all three). Claude
  tool-call round not probed for the same reason.
  ASSUMPTION: Anthropic OpenAI-compat tool-call support tested via unit-level
  parser-surface mock; live validation deferred to operators with valid keys.

## [0.17.1-beta.18] - 2026-07-18

### Pre-finish checklist rule 8: honest ledger (claims must match the diff)

From reviewing the beta.17 Kimi build: the work itself was correct, but the
commit message claimed a `cached_tokens` feature that already existed
(`59b1102`) and "pricing, balance parse" tests that were never written. The
existing seven rules catch code mistakes; none catches a REPORT that
overstates the diff.

- **feat(prompt): "Honest ledger" rule in the pre-finish checklist
  (`systemPrompt.ts`).** Every commit-message bullet / report claim must
  correspond to a change actually in the staged diff (re-read against
  `git diff --staged --stat` before committing); pre-existing behavior is
  reported as "already present (verified)", never claimed as new; a named
  test/deliverable not produced is "skipped: <reason>", not silently implied.
  Full rule in non-lite; compressed claim-accuracy clause in lite.
- **test:** `systemPrompt.test.ts` asserts rule 8 in both modes; the lite
  token-budget assertion still holds.

## [0.17.1-beta.17] - 2026-07-18

### Add Kimi (Moonshot AI) provider

New OpenAI-compatible provider powered by Moonshot's `kimi-k2.7-code`
(coding-focused, 256k context), `kimi-k2.6`, `kimi-k2.5`, and the
flagship `kimi-k3` (1M context) models.

- **feat(provider): kimi adapter (`src/providers/adapters/kimi.ts`).**
  Matches `api.moonshot.ai` (and `.cn`) base URLs. Strips `temperature`
  and `top_p` (fixed server-side on k3/k2.7/k2.6) and unsupported
  `tool_choice: "required"`. Default model `kimi-k2.7-code`.
- **feat(provider): per-adapter `apiKeyEnv` on `ProviderAdapter`.**
  `deepseek` → `DEEPSEEK_API_KEY`, `kimi` → `KIMI_API_KEY`; the mac
  app now injects provider-specific env vars generically instead of
  hardcoding DeepSeek.
- **feat(env): `KIMI_API_KEY` and `MOONSHOT_API_KEY` env support.**
  Both fall back to `TANYA_API_KEY`; `KIMI_BASE_URL` override works.
- **feat(pricing): kimi pricing table in runLogs.** Per-model pricing
  for `kimi-k2.7-code` ($0.72/$3.50), `kimi-k2.6` ($0.95/$4.00,
  cache $0.16), `kimi-k2.5` ($0.60/$3.00, cache $0.10).
- **feat(balance): `tanya cost` and `testProvider` show kimi balance.**
  `GET {base}/users/me/balance` → `available_balance` with optional
  `voucher_balance`/`cash_balance` detail.
- **feat(mac): env injection uses `apiKeyEnv` from provider descriptor.**
  Deletes the hardcoded `DEEPSEEK_API_KEY` special case; any provider
  can declare its key env name.
- **test:** kimi adapter registration, alias resolution, `preRequest`
  stripping, pricing, balance parsing, providers-list descriptor.
- **ASSUMPTIONS (no live key at build time — probe before relying):**
  parallel tool calls off, JSON mode on, schema flattening off, and the
  balance payload field names are taken from docs, not probed;
  `kimi-k3` / `k2.7-code-highspeed` pricing is deliberately absent from
  the table (unknown model → no cost line) until verified. Run
  `TANYA_RUN_LIVE_PROVIDER_TESTS=1 tanya providers test --provider kimi`
  with a real key to settle these (see KIMI_PROVIDER_PLAN.md VERIFY-LIVE).

## [0.17.1-beta.16] - 2026-07-18

### Pre-finish checklist: turn seven recurring first-pass misses into a gate

Derived from a review of Tanya's App Store Images work (cosmohq-v3). Each item
below was a first-pass mistake Tanya later self-corrected or a human caught.
Encoded as a short, checkable list the agent must clear BEFORE reporting a
coding task done — so the FIRST pass is right instead of relying on a later
reviewer. Prompt-level only: no gate arming or judgement changed.

- **feat(prompt): pre-finish checklist block (`systemPrompt.ts`).** A new
  `## Pre-finish checklist (coding)` section, always present for the full
  prompt and compressed for lite. Seven rules:
  1. **Shared-state writes** — for any array/column/collection/JSON field you
     wrote, if another slot/device/entity/locale also writes it, read + merge
     (union, dedupe, stable order); never overwrite with only your slice. (The
     canonical miss: an iOS `screenshots` column shared by iPhone and iPad,
     where saving one device blindly clobbered the other's screenshots.)
  2. **Precedent first** — grep how the same column/field is written elsewhere
     and mirror the established merge/ordering/URL conventions before inventing.
  3. **Green and reported** — run the touched files' whole suite + typecheck +
     lint (not just the one test you added), and report every red, including
     pre-existing/unrelated ones in files you edited, with whether you caused it.
  4. **Spike before feature** — if a task makes a spike or findings artifact its
     first deliverable, produce it before writing feature code.
  5. **Leave no trace** — in the same change that swaps or removes a
     component/call/prop, delete the orphaned imports, props, and dead branches.
  6. **Per-task status** — end a numbered/multi-part plan with a per-item
     done/partial/skipped line (reinforces the existing deliverable rule).
  7. **Hosted, not base64** — persist media into DB rows/arrays as hosted URLs
     (upload first), never raw `data:` base64.
- **test:** `systemPrompt.test.ts` gains coverage that the full prompt ships all
  seven rules and lite keeps the shared-state + base64 rules while staying terse;
  the existing lite-token-budget assertion still holds.

## [0.17.1-beta.15] - 2026-07-17

### Task-reliability round: baseline-aware verification + three steering fixes

Four-part hardening from `BETA15_TASK_RELIABILITY_PLAN.md`, derived from the
three live stalls of 2026-07-14..16. Purely additive: no gate's arming or
judgement changed. Every part is fail-closed by design.

- **feat(quality): baseline-aware verification (Go-first).** The big one — a
  broad `go test ./...` failure whose failing packages are ALL untouched by
  the run is very likely a pre-existing red test, not something the run broke
  (the exact shape that cost a full session: `internal/store/apple`, broken by
  an earlier unrelated commit, unrelated to the task at hand).
  - Early nudge (`runner.ts`): the failing tool result gets a classification —
    "The failing package(s) … were not touched by this run — this is likely a
    pre-existing failure. Re-run scoped to what you changed …" — steering the
    model away from fixing code it doesn't own.
  - Finalize reclassification (`report.ts`): re-runs the failing packages in a
    THROWAWAY WORKTREE checked out at the session's starting commit. Only a
    confirmed failure THERE removes the blocker (replaced by an honest
    `Pre-existing test failure (verified at base <sha>): …` report note).
    Passing at base means the run introduced it — the blocker stays, annotated
    `— introduced by this run (passes at base <sha>)`. Any doubt (a touched
    package, no starting commit, the worktree itself failing to create) keeps
    the blocker exactly as it was.
  - New `src/agent/baselineFailures.ts` (pure parsing/matching) and
    `manifest.gates.baseline` in the run archive.
  - `cleanTreeBuild.ts`'s worktree lifecycle is now shared via
    `runCommandInDetachedWorktree`, used by both the existing clean-tree gate
    and this new check.
- **feat(observability): classified stall messages.** The interactive pause's
  `Stuck on:` line now carries the SAME classification (parse error /
  pre-existing failure) the tool result already got in beta.13/14 — a user
  pasting the stall detail sees why, not a bare `Shell exited 1.`.
  `sessionBaseHead` is now set for every run (not only ones the coding-intent
  heuristic classifies as a task), since baseline-aware verification needs it
  regardless.
- **feat(quality): literal-pipe grep nudge.** Plain `grep`/`zgrep` treat `|` as
  a LITERAL character (BRE), not alternation — `grep "a|b"` searches for the
  three-character string "a|b", not "a" OR "b". A no-match result from such a
  pattern (no `-E`/`-P`/`-F` flag) now gets a hint: `` re-run with `grep -E` ``.
  Excludes `egrep`/`rg`/`ag` (extended by default) and `fgrep` (fixed by
  design, no hint needed). `literalPipeHint` in `src/tools/fsTools.ts`.
- **feat(quality): near-duplicate retry breaker.** The existing repeated-
  failure guard only fires on a byte-identical command. A model tweaking small
  variants (different flags/pattern/dir) hunting the same underlying failure
  evaded it. New fingerprint by (binary, failure text) — on the 3rd
  distinct-but-same-failure command, appends a strategy-change nudge. Never
  skips the command (that stays the exact-label guard's job) — only nudges.
- test: 33 new tests — `baselineFailures.test.ts` (14, pure parsing), real-Go-
  fixture integration tests in `baselineVerification.test.ts` (7, real `go
  test` + real worktree checkouts proving pre-existing/introduced/inconclusive/
  touched-package containment), `stallClassification.test.ts` (2, end-to-end
  `Stuck on:` assertions), `nearDuplicateRetry.test.ts` (3), plus 7 new cases
  in `runShell.test.ts` for the literal-pipe hint.

## [0.17.1-beta.14] - 2026-07-14

### Fix: a shell **parse error** is surfaced clearly (not a bare "exit 1")

Follow-up to beta.13. A different stall shape: an agent re-ran a `grep` whose
pattern had an **unmatched backtick** (`… struct|`json"`), which zsh rejects at
parse time (`zsh:1: unmatched "`) and never executes. The tool reported only
"Shell exited 1.", so the agent retried the same broken string and stalled.
Unlike a no-match search, this is a REAL error — the fix is to make it
actionable, not to forgive it.

- feat(tools): classify shell parse/syntax errors (unbalanced quote/backtick/
  paren, bad substitution) — anchored to a leading `zsh:`/`bash:`/`sh:` prefix so
  a program that merely prints "syntax error" isn't mislabelled — and return
  "Shell parse error — the command was NOT executed … fix the quoting; retrying
  the same string will fail identically." `src/tools/fsTools.ts` `isShellParseError`.
- test: the unmatched-backtick command is labelled a parse error; an ordinary
  non-zero exit (`false`) is not; program output containing "syntax error" is not.

## [0.17.1-beta.13] - 2026-07-14

### Fix: a no-match `grep … 2>&1` no longer reads as a shell failure

A search that legitimately finds nothing exits `1` (grep/rg: `0`=match,
`1`=no-match, `2`=error). `run_shell` already normalizes a bare no-match search
to a non-failing "no matches" answer — but `isBareSearchInvocation` rejected any
command with a redirect, so `grep … 2>&1` (and `2>/dev/null`, `>/dev/null 2>&1`)
fell through and was reported as `Shell exited 1`, which the model re-ran and the
stall detector saw as a phantom failing check (observed: a run got "Stuck on:" a
grep that had nothing to find).

- fix(tools): strip a **trailing** stderr/stdout redirect before the bare-search
  check — a redirect doesn't change a search's exit code, so `grep … 2>&1` exit 1
  is still an answer. A redirect before a pipe/chain still keeps real exit
  semantics, and a genuine grep error (exit 2) is unaffected (guarded on exit
  code `1`). `src/tools/fsTools.ts` `stripTrailingRedirects`.
- test: no-match grep with `2>&1` / `2>/dev/null` / `>/dev/null 2>&1` returns a
  no-match answer; a real error (exit 2) stays a failure even with `2>&1`.

## [0.17.1-beta.12] - 2026-07-14

### Make the gates observable + stale-binary guard

Round-3 hardening (follow-up to the beta.10/beta.11 gate fixes, which the
2026-07-14 hosting run confirmed working). Purely additive — gate arming and
judgement are unchanged; this is observability + staleness only.

- feat(observability): run archives (`.tanya/runs/<runId>.json`) now carry a
  structured `gates` section — `armed` + `armedReason`, and per-gate verdicts
  for `verifyGate` (each required command + evidence), `commitCompleteness`
  (uncommitted paths), `cleanTreeBuild`, and `specCoverage.items` (one row per
  deliverable with `state`/`evidence`/`repeatOffense`). Every gate records its
  verdict even on pass; disarmed runs record why. `archiveVersion: 2` (old
  archives are not migrated). `src/agent/gateReport.ts`
- feat(observability): every archive records `binaryVersion` / `binaryBuiltAt`,
  so future forensics never have to guess which code ran (the beta.9 forensics
  burned time eliminating exactly that hypothesis). `src/agent/buildInfo.ts`;
  tsup compiles a fresh build id into the bundle + a `dist/BUILD_ID.json` sidecar.
- feat(quality): stale-binary guard — a long-lived `tanya serve` process compares
  its compiled-in build id against `dist/BUILD_ID.json` at startup and on every
  task submission. On mismatch it emits a prominent "Tanya was upgraded — restart
  to pick up fixes" warning, records `binaryStale: true` in the archive, and adds
  a non-gating nudge to the final report of task runs. (A serve process never
  re-reads `dist/`, so before this it silently ran old code — gates included.)
- feat(observability): run-archive discoverability — a run driven from a
  workspace root drops a `<runId>.at` pointer in each touched repo's
  `.tanya/runs/` and lists `touchedRepos` in the archive, so an auditor finds the
  archive from the repo it edited. Lookup rule documented in the README.
- test: `gateReport`, `buildInfo`, `runArchivePointer` unit suites; the gate
  canary now asserts the archive's `gates` section, `archiveVersion`, and
  `binaryVersion`; a stale-binary nudge test proves it never fails the verdict.

## [0.17.1-beta.11] - 2026-07-14

### Prove the gates bite + close the test-target gap

Live-verification follow-up to beta.10 (`docs/gate-canary-2026-07-14.md`,
`docs/gate-escape-2026-07-13.md` "LANDED" section).

- test(quality): gate canary — drives the REAL interactive path against a
  gate-violating task and asserts a FAIL verdict naming the uncommitted file,
  the dropped deliverable, and the unrun verify command (the acceptance test
  that never existed). `src/agent/__tests__/gateCanary.test.ts`
- fix(quality): commit-completeness missed a file created in a NEW directory —
  `git status --porcelain` collapses an untracked dir to `dir/`; added
  `--untracked-files=all` so `dirtyPathsInRepo` lists `dir/file` individually
  (the exact E1/E6 new-package-dir shape). Caught by the canary.
- feat(quality): clean-tree build now compiles TEST targets without running them
  (`xcodebuild build-for-testing`; `go build ./… && go test -run '^$' ./…`) so a
  commit whose test target no longer compiles can't pass an honest plain `build`
  (CosmoKit FIX3 escape). Opt out with `compileTests: false`.
- feat(observability): run archives now record `verdict` + `gateLog`. Interactive
  runs archive to the SERVE cwd (not the nested target repo) — the gotcha that
  hid them during the audit; now documented.

## [0.17.1-beta.10] - 2026-07-14

### Gate-escape hardening — the beta.9 gates now fire in the mac app

Forensic follow-up (`docs/gate-escape-2026-07-13.md`): the beta.9 gates were
reproduced-through by the very next runs. Root cause — every hard gate and the
FAILED verdict were guarded by `!interactive`, and the mac app runs every turn
`interactive: true`, so a pasted engineering task bypassed all of them. `interactive`
is a transport flag, not an intent flag.

- fix(quality): intent gating, not transport gating — a coding task that changed
  files, or any prompt with task structure (≥2 numbered deliverables or a `## Verify`
  section), is now held to the verify / commit-completeness / clean-tree / spec-coverage
  gates and the FAILED verdict, even when run interactively. A plain chat turn stays
  soft, so a working app is never false-failed. Opt out with `TANYA_TASK_GATES=off`
  or `metadata.taskGates: false`. Interactive reports render concise (no raw JSON dump).
  (gate-escape E1/E3/E6/E8)
- fix(quality): a GATING validator ERROR (goose / migration-collision / localization)
  now flips the run verdict, not just the footer — the badge could previously read
  PASSED while "Gate results: FAILED" listed an unrepaired miss (gate-escape E2)
- feat(quality): three new nudge-tier reachability detectors — empty-comment-only
  conditional bodies, constant-default fields whose branch is dead, and analytics
  `track` emits deleted in a rewrite (gate-escape E4)
- feat(quality): repeat-offense marking — a deliverable left unfinished in a recent
  prior run is flagged `⚠ repeat-offense` in the coverage table
  (`.tanya/spec-coverage-history.json`) (gate-escape E7)
- feat(quality): widen localization extraction to `L10n.format(…)` and
  `String(localized: …)` (gate-escape E2)
- feat(observability): gate-decision breadcrumbs (`manifest.gateLog`) record which
  gates armed and how they voted, so a forensic starts from data, not inference

## [0.17.1-beta.9] - 2026-07-13

### Quality gates — runs can no longer report success while work is missing

Six mechanical gates, from a forensic audit of two runs that shipped broken/partial
work and self-reported success. Objective failures hard-block the SUCCESS verdict
and drive the repair loop; heuristics are non-gating nudges so a working app is
never false-failed. All gates fire on every finalize path — including the
stall/turn-limit tail where the audited run silently skipped verify + commit.

- feat(quality): spec-coverage gate — every `## Part N` / `### G1` deliverable must
  be accounted for in the report (done/skipped) or the run fails (kills silent drops)
- feat(quality): verify-gate — commands in a `## Verify` / `## Acceptance` section
  must run with passing evidence; boot-smoke hook auto-requires a restart/health
  check on infra edits (`.tanya/boot-smoke.json`)
- feat(quality): commit-completeness gate — a file the run wrote and left
  uncommitted, in ANY repo it touched (incl. nested), blocks the run
- feat(quality): static ERROR checks — goose `+goose Up/Down` annotations,
  migration-number collisions, localization key parity across sibling locale files
- feat(quality): nudge-tier reachability + external-fact checks — dead enum
  cases / Go exports, no-op UI handlers, hardcoded exit-codes with no ASSUMPTION
- feat(quality): clean-tree build check — rebuild the committed HEAD in a throwaway
  worktree so a committed file referencing an untracked one can't pass
  (`.tanya/clean-tree-build.json`, opt-in)
- feat(quality): report honesty — coverage table, commit SHA + `git show --stat`,
  rendered gate results, and declared ASSUMPTION list in the deterministic report

## [0.17.1-beta.8] - 2026-07-12

### Changes

- feat(tools): fetch_url is content-type aware (JSON/text passthrough, refuse binary)
- feat(tools): web_search falls back to the lite endpoint when DDG blocks
- fix(mac): transcript no longer renders blank after replay/session switch
- feat(prompt): tell the agent about web_search/fetch_url (CDX-06 follow-up)
- feat(tools): web_search + fetch_url read-only web tools (CDX-06)
- feat(commands): /review builtin for working-tree and staged diffs (CDX-03)
- mac app: wire New Task (worktree) + image paste to the CLI; fix crash
- feat(tools): read_image OCR tool for screenshots (CDX-07)
- feat(serve): worktree-isolated task sessions (CDX-04)
- mac app: stop the Desktop-access permission loop on project restore
- Add per-turn changed-files card in transcript with View diff action
- Add approval-mode picker (Ask/Code/Auto) to mac app footer bar
- gitignore: keep .planning/ out of the public repo
- compact: keep-recent tool-result clearing + structured summary prompt
- mac app: unfreeze heavy-session scrolling; suspend long-idle children
- eval: report suite cache hit-rate; docs: cache economics are modeled now
- serve: pin one system prompt per session for provider prefix-cache hits
- mac release: direct ASC-key notarization, version stamping, --publish
- feat(cost): M15 slice 1 — cache hit-rate in /cost + real DeepSeek balance
- feat(mac): window long transcripts — render the recent 200, expand on demand
- fix(tools): grep exit 1 is "no matches", not a failing check
- fix(mac): blank transcript on long sessions — drop bottom scroll anchor
- feat(serve): auto-continue after stall stops instead of always asking
- fix(mac): transcript follows the bottom through reasoning streams and expansion
- feat(runner): stall stops name the check that kept failing
- fix(mac): survive child crashes — no more app kills, dead sessions reconnect
- feat(agent): remove the step ceiling — unlimited turns, stall-only stops
- mac: run multiple sessions concurrently + sidebar working indicator
- mac: fix New Session showing the previous conversation


## [0.17.1-beta.7] - 2026-07-09

### Changes

- Merge pull request #38 from maththedev42/feat/known-issues-registry
- feat(agent): known-issues baseline registry to stop re-diagnosing pre-existing red gates
- Merge pull request #37 from maththedev42/fix/token-runaway-backstop
- fix(runner): stop a stalled run before its tokens balloon
- Merge pull request #36 from maththedev42/fix/repeated-failure-guard
- fix(runner): cap identical failing commands with a generic repeated-failure guard
- Merge pull request #35 from maththedev42/fix/probe-never-gates
- fix(verify): a failed read-only probe never gates the run
- Merge pull request #34 from maththedev42/fix/commit-default-dod
- fix(agent): make committing finished work the default coding DoD
- Merge pull request #33 from maththedev42/feat/mac-jump-to-bottom
- feat(mac): add a jump-to-latest button when scrolled up
- Merge pull request #32 from maththedev42/fix/mac-stream-autoscroll
- Merge pull request #31 from maththedev42/fix/session-cost-cache-aware
- fix(cost): apply the cache-hit discount to persisted session cost
- perf(mac): memoize markdown parsing so long transcripts scroll smoothly
- fix(mac): keep the transcript pinned to the bottom while streaming
- Merge pull request #30 from maththedev42/fix/serve-always-extend-budget
- fix(serve): always extend the turn budget on progress for interactive runs


## [0.17.1-beta.6] - 2026-07-08

### Changes

- Merge pull request #29 from maththedev42/fix/mac-onboarding-file-permissions
- mac: front-load macOS file-access permission at onboarding
- Merge pull request #28 from maththedev42/feat/mac-queued-prompts-strip
- mac: move queued prompts to a strip above the composer (Codex-style)
- Merge pull request #27 from maththedev42/fix/transcript-stick-to-bottom
- mac: keep the transcript pinned to the bottom while streaming
- Merge pull request #26 from maththedev42/feat/skill-packs-django-sveltekit
- feat(skills): add framework/django and framework/svelte-kit packs
- Merge pull request #25 from maththedev42/feat/mac-08-packaging
- Merge remote-tracking branch 'origin/main' into feat/mac-08-packaging
- Merge pull request #21 from maththedev42/feat/serve-stdio-gui-surface
- Merge pull request #23 from maththedev42/fix/session-listing-home-tanya
- Merge pull request #22 from maththedev42/fix/research-before-scaffold
- Merge pull request #24 from maththedev42/feat/deepseek-cache-hit-pricing
- feat(cost): bill DeepSeek cache-hit prompt tokens at the discounted rate
- mac: enforce a single app window
- cost: cache-aware pricing, "est." label, and resume footer seeding
- fix(sessions): don't treat home ~/.tanya as a project; recover orphaned sessions
- mac: live "Thinking…" indicator + expand reasoning while streaming
- fix(sessions): don't treat home ~/.tanya as a project; recover orphaned sessions
- feat(agent): research the workspace before declaring something absent
- feat(agent): research the workspace before declaring something absent
- feat(cli): serve --stdio + machine-readable surfaces for GUI clients
- mac: reconcile onboarding with the keychain; harden setSecret
- mac: footer shows configured provider/model before a session starts
- mac: dev-build.sh — build+run signed with a stable local identity
- mac: kill the live Tanya child before deleting its session files
- mac: stop Keychain-prompt storm at launch; robust project restore
- mac: fix composer that wouldn't accept focus/typing (TextKit 1)
- mac: focusable compact composer, right-sized window, rename sessions
- mac: checklist onboarding that installs the CLI and stores the key
- feat(mac): Developer ID signing, notarization, DMG packaging
- feat(mac): settings (providers/keys) + doctor-based onboarding
- feat(mac): diff viewer + command palette + @file mentions
- feat(mac): projects & sessions sidebar + multi-window
- feat(mac): add activity panel permissions
- feat(mac): build chat window
- feat(mac): scaffold SwiftUI stdio bridge
- feat(cli): add stdio serve protocol
- docs(prompts): macOS app plan + 8 delegate prompts
- docs(prompts): Codex-style TUI plan + 7 delegate prompts


## [0.17.1-beta.5] - 2026-06-24

### Changes

- feat(dod): inject the definition-of-done block centrally in buildSystemPrompt
- test(dod): prove the runner nudges once and still finalizes PASSED
- feat(dod): runtime definition-of-done gate — "it compiled" is not "it works"


## [0.17.1-beta.4] - 2026-06-15

### Changes

- fix(agent): force --tier1 for behavior testing; drop the bogus timeout flag
- feat(tier1): thorough, adversarial UI testing — verify every function, not a glance
- feat(tier1): live narration + deterministic OCR artifact safety net
- fix(tier1): DeepSeek thinking-mode verdict + on-device OCR for visual bugs
- feat(sessions+disk): runs save resumable sessions; tanya clean + auto-retention bound .tanya growth
- fix(repl): resumed sessions replay the previous chat — append, never replace, under <Static>
- docs(brand): Tanya safety rules sheet
- chore: gitignore the legacy .tania dot-dir
- feat(repl): /resume with no id opens an interactive session picker
- fix(verifier): recognize probes behind 'set -o pipefail;' prefixes + archive-inspection probes
- fix(tools): raise run_command/run_shell timeout ceiling to 600s
- feat(tier1): natural-language runtime testing — /test-app --tier1 + agent knows the harness
- docs: Tier-1 agentic UI testing section in the runtime-testing chapter
- test(runtime): metadata.tier1 alone activates the runtime-boot verifier
- fix(tier1): countdown nudge + forced final verdict — exploration-happy models must still verdict
- refactor(tier1): DeepSeek-native UI testing — the agent reads the accessibility tree, no vision model
- fix(runtime): resolve idb from pipx's ~/.local/bin in the harness PATH
- fix(tier1): real taps on iOS+Android — coordinate mapping, idb ui text, Android driver+video, self-fix report
- feat(runtime): Tier-1 agentic UI tester — vision model watches the running app


## [0.17.1-beta.3] - 2026-06-12

### Changes

- Merge pull request #19 from matheusjkweber/feat/runtime-tester
- Merge pull request #18 from matheusjkweber/docs/architecture-and-roadmap
- feat(runtime): --record captures a boot video on iOS (simctl recordVideo)
- fix(runtime): never unref an awaited sleep timer — silent exit-0 mid-boot
- fix(runtime): two real-app findings from cosa-nostra smokes
- feat(runtime): macos boot adapter + docs — Tier-0 complete across all platforms
- feat(runtime): ios boot adapter + shared Apple helpers
- feat(runtime): android boot adapter
- feat(runtime): opt-in runtime-boot ring in the final-state verify chain
- feat(runtime): script/CLI boot adapter + /test-app slash command + dogfood
- feat(runtime): web/landing boot adapter + blank-first-frame heuristic
- feat(runtime): backend boot adapter + headless `tanya test-app` command
- feat(runtime): Tier-0 boot-test core — contract, exec seam, detection, orchestrator
- fix(report): diagnostic probes never gate a green build
- fix(fsTools): append standard bin dirs to PATH for bare command spawns
- fix(report,fsTools): stop two more mobile-step false negatives
- fix(report): recover transient network-fetch probe failures
- fix(report): don't FAIL coding verdict on an empty final-state verifier set
- docs: add Phase 1 Hooks design
- docs: architecture map + Claude-Code parity roadmap


## [0.17.1-beta.2] - 2026-06-07

### Changes

- lang/python skill pack added to the project (#17)
- docs: architecture map + Claude-Code parity roadmap (#16)


## [0.17.1-beta.1] - 2026-05-31

### Changes

- feat(ui): live token/cost counter with configurable DeepSeek pricing (#15)
- fix(tools): make run_shell progress throttle env-tunable for tests (#14)
- fix: app-build reliability — stop mid-task, full-screen blink, compiled≠correct (#12)
- [Audit] production-readiness batch + Tania→Tanya rename (2026-05-25) (#11)


## [0.17.1-beta.0] - 2026-05-24

### Changes

- Audit: production-readiness fixes (HIGH+MEDIUM+LOW) (#10)
- chore(funding): drop github key until Sponsors enrolment lands
- chore: add funding handles
- chore: add funding handles
- feat(router): make the per-turn reasoning cap env-configurable (#6)
- plan-and-dispatch: drop the hard per-subtask file cap
- raise plan-and-dispatch subtask file cap from 5 to 8


All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Diagnostic probes never gate a green build. The recoverable-probe set now
  covers tool/version detection (`which`, `command -v`, `type`, `hash`,
  `… --version`/`-version`, `tool version`) and existence/inspection checks
  (`test`, `[ … ]`, `stat`, `file`, `printenv`) in addition to `cat`/`ls`/`find`.
  Combined with the build-passed exploratory cleanup, a failed diagnostic probe
  (e.g. `which fastlane`, `xcodebuild -version`, `test -f …`) no longer produces
  a false `TANYA RESULT: FAIL` when the authoritative build passed. Real quality
  gates (build/test/lint failures) are not matched and still gate. This is the
  general rule behind the prior per-class probe/fetch recovery fixes.

- Bare (`shell:false`) command spawns now append the standard executable dirs
  (`/usr/bin`, `/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, …) to PATH. When a
  CLI host launches Tania with an incomplete PATH, direct spawns resolved the
  binary against the deficient `process.env.PATH` and ENOENT'd ("Command failed
  to start") on bare `which`, `xcodebuild`, `swiftlint`, etc. — even though the
  run_shell tool found the same tools fine (it goes through `zsh -lc`, which
  reloads the login PATH). Tool-presence probes failed → false `TANYA RESULT:
  FAIL` on green builds. The inherited PATH still takes precedence, so a
  deliberate toolchain wins.

- Exploratory probe/bootstrap failures (`ls`, `find`, `mkdir`, `cp`, `sqlc
  generate`, tool installs, …) are now reclassified as recovered when the run's
  inline verification contains a passing authoritative build — not only when the
  final-state verifier's authoritative checks passed. Mobile (iOS/Android) steps
  produce no authoritative final-state check (XcodeGen apps have no
  `Package.swift`; the Android verifier's only check is non-authoritative), so
  this cleanup previously never ran for them, stranding recoverable probe
  failures as blockers → false `TANYA RESULT: FAIL` on green builds.
- The shell workspace-mutation guard no longer falsely rejects in-workspace
  writes (`cd <abs-worktree> && echo … >> .gitignore` → "mutation outside
  workspace") on macOS, where the worktree's real path is `/private/var/folders/…`
  but the workspace root is stored as the `/var/folders/…` symlink form.
  `pathInsideWorkspace` now canonicalizes symlinks on both sides before
  comparing; a genuinely-outside path still resolves outside.

- Transient network-fetch probe failures (curl/wget exit 56 / 5xx from
  cold-start backends like Azure App Service) no longer linger as blockers when
  the fetch recovered. A failed fetch is reclassified as recovered when a later
  verification line fetched the SAME resource (same host + path basename, so a
  `--retry`/`--connect-timeout` retry or a sibling path counts) or the run's
  authoritative build later passed. Non-fetch failures and fetches that never
  recovered still gate.

- Coding verdict no longer reports `TANYA RESULT: FAIL` when the final-state
  verifier ran no applicable checks (e.g. an XcodeGen iOS app with no
  `Package.swift`, where no builtin verifier's `appliesTo()` matches). An empty
  final-state set is inconclusive, not a failure — the run's inline verification
  (build/test commands) and the blocker list already gate correctness.
  Authoritative final-state checks that actually fail still surface as blockers
  and FAIL. Previously `authoritativePassed === false` (which requires at least
  one authoritative check to exist) was treated as a hard failure, producing
  false negatives on otherwise-green runs.

## [0.17.0] - 2026-05-21

### Added

- Full-screen Claude-Code-style TUI for the interactive `tanya` chat REPL
  (TTY only, opt out with `--no-tui` or `TANYA_TUI=off` /
  `TANYA_TUI=off`).
- TUI footer status bar shows model, session elapsed time, cumulative cost,
  session token count, and slash-command hint text.
- Permission prompts now render as an Ink modal during chat sessions.
- REPL shows a thinking spinner while waiting for the first token in TTY mode.
- REPL prompts and assistant responses now include local clock timestamps, for
  example `[14:32:09] You:` and `[14:32:21] Tanya · 5.1s:`.
- Each REPL assistant response is prefixed with its generation time, for example
  `Tanya · 3.2s:`.
- `/exit` and `/quit` print a REPL session summary with walltime, generating
  time, and turn count.
- REPL thinking spinner shows elapsed seconds from the first frame, for example
  `Tanya: ⠋ thinking… (0s)`.
- Ink TUI now shows real-time reasoning and tool activity during a turn, then
  folds it into a one-line completion summary.
- Ink TUI now renders assistant Markdown with styled inline text, lists,
  quotes, headings, and fenced code blocks.
- Ink TUI now shows a launch warmup banner plus a first-turn cold-start hint in
  the footer while DeepSeek V4-Pro and project commands initialize.
- One-time-per-process stderr warning when DeepSeek legacy model names
  (`deepseek-chat`, `deepseek-reasoner`) are used. They're V4-Flash
  compatibility aliases scheduled for deprecation by DeepSeek on 2026-07-24.
  Suppressible via `TANYA_SUPPRESS_DEPRECATION=1` (envCompat fallback
  `TANYA_SUPPRESS_DEPRECATION=1`). Migration story in
  `docs/providers.md#deepseek-v4-deprecation`. Proper thinking-mode config
  redesign tracked as M13.

### Changed

- Coding tasks in the backend foundation phase now receive a 300-turn budget
  while setup/auth, feature, and testing phase budgets stay unchanged.
- New runtime dependencies: `ink` and `react`; slash-command output in the
  interactive TUI renders as system-message bubbles in chat history.
- DeepSeek default model is now `deepseek-v4-pro` (was `deepseek-chat`).
  Legacy names still work; `deepseek-chat` continues to print the V4
  deprecation warning until 2026-07-24.
- `/cost` and `/budget` now label estimates as `[cache-miss estimate]` for
  DeepSeek and other providers whose cache-hit pricing isn't yet modeled. Real
  bills typically run 30-80% lower due to cache hits on stable prompts. Proper
  cache-hit accounting ships with M13 (DeepSeek V4 thinking-mode redesign).
- Scrubbed committed absolute home-directory paths from code/docs.
- Reworded CosmoHQ-internal references in skill packs and tests where the wording was internal-coded rather than intentional public context; preserved CosmoHQ-as-consumer references in integration docs.
- Sanitized email references in test fixtures (`user@example.com`); preserved intentional public contact emails in `SECURITY.md` / `CODE_OF_CONDUCT.md` / `package.json`.

### Removed

- 8 internal Codex prompt files from the repo root (`CODEX_PROMPT_*.md`) that were committed during pre-launch development.
- 11 internal per-milestone development status snapshots (`docs/M*-status.md`, `docs/PROGRESS.md`) — superseded by CHANGELOG entries and the milestone-tracking in the project's Obsidian vault.
- One-time `docs/expertise-pack-refresh-plan.md` (work executed; doc is no longer relevant).

### Fixed

- Force-terminated coding runs no longer surface the final failed probe command
  as a blocker when final-state authoritative Verify checks pass.
- DeepSeek round-trip reasoning requests now coerce assistant history entries
  with `content: null`, `reasoning_content`, and no `tool_calls` to
  `content: ""` only in the DeepSeek wire body. This avoids DeepSeek's
  `content or tool_calls must be set` HTTP 400 without changing stored history
  or non-DeepSeek adapters.
- Ink TUI input box now shows a live spinner with elapsed-seconds counter while
  a turn is pending, instead of a static `waiting…` string.
- Ink TUI assistant messages now render incrementally as tokens stream in,
  using coalesced state updates instead of one reducer dispatch per token.
- Ink TUI latency is reduced by coalescing per-token dispatches and memoizing
  message bubbles to avoid full history re-render work on every streamed token.
- DeepSeek thinking-mode conversations now preserve assistant
  `reasoning_content` in Tanya's in-memory history and round-trip it back only
  to DeepSeek on subsequent OpenAI-compatible requests. This fixes DeepSeek
  HTTP 400 failures after the first streamed assistant turn without changing
  OpenAI, Qwen, Grok, Groq, Together, Ollama, or Anthropic wire bodies.
- REPL no longer prints the assistant response twice when streamed output and
  the final event contain the same message.
- REPL thinking spinner now shows elapsed seconds, for example
  `Tanya: ⠋ thinking… (8s)`, so slow responses do not look stalled.
- Ink TUI finalized history now renders through Ink `<Static>`, so the visible
  conversation does not blink on every keystroke or streamed token.
- Ink TUI residual blink is reduced by sharing a single one-second ticker,
  removing Input/Footer border redraws, and stabilizing the input clock string
  to the shared tick.

## [0.16.0-beta.0] - 2026-05-16

### Added

- Added the M8 eval harness that logically slotted as v0.12 in the planned
  sequence; v0.12 was skipped during the marathon, so the release moves forward
  as v0.16.0-beta.0.
- Added versioned eval suite/result schemas, `tanya eval` runner support,
  dry-run estimates, deterministic reporting, markdown comparison output, and
  nightly eval CI scaffolding.
- Added Tanya-native, SWE-bench-Lite, CosmoHQ, `eco-30`, and
  `verifier-self-test` suites. `eco-30` makes cost a first-class metric with
  cost-per-pass, tokens-per-pass, reasoning-share, and >=20% cost-regression
  gates.
- Added public benchmark snapshots and docs covering eval formats, runner
  isolation, determinism, scoreboard updates, and full SWE-bench cost guidance.
- Eco-30 smoke on `deepseek/deepseek-chat` for the first three tasks completed
  at 2/3 passed, `$0.240746` total, and `$0.120373` per pass; the full
  all-provider baseline remains an operational follow-up.

## [0.15.0-beta.0] - 2026-05-16

### Added

- Added an interactive-only live status footer for `tanya chat`, derived from
  existing EventSink events. It surfaces provider/model routing, route step,
  spend, active tools, child agents, permission prompts, escalations,
  compaction, and prompt-budget warnings without changing event semantics.
- Added TTY-guarded rendering with `TANYA_LIVE_STATUS=0` /
  `TANYA_LIVE_STATUS=0` opt-out, plus byte-invariance coverage for non-TTY,
  JSONL, and Cosmo bridge output.
- Added [docs/live-status.md](./docs/live-status.md) with terminal behavior,
  streaming compatibility, and full-TUI tradeoffs.

## [0.14.0-beta.0] - 2026-05-16

### Added

- Added the verifier-aware `edit_block` tool with exact block replacement,
  expected-count enforcement, structured mismatch reasons, permission-gated
  fuzzy recovery for whitespace and nearby-context drift, audit-visible
  candidate metadata, repair hints, and a golden near-match fixture.
- Recovery-rate sample: 16/20 near-match cases recovered cleanly and 4/20
  failed closed by design; the M10 golden comparison preserves verifier verdicts
  while the fuzzy-enabled path uses fewer turns than exact retry.

## [0.13.0-beta.0] - 2026-05-16

### Added

- Added structural repo-map generation under `.tanya/index/repo-map.json`,
  covering TypeScript/JavaScript, Python, Go, Swift, and Kotlin with parser
  provenance, symbol/import/export extraction, incremental cache invalidation,
  branch/schema rebuilds, and debug-prompt diagnostics.
- Added lite-prompt repo-map injection with deterministic ranking, prompt-budget
  dropping, `/budget` repo-map token accounting, and the `inspect_repo_map` tool
  for on-demand structural lookup.

## [0.11.0-beta.0] - 2026-05-16

### Added

- Added first-class reasoning-model handling for DeepSeek-R, Qwen3-Thinking,
  and Grok reasoning-style outputs: reasoning chunks are split from assistant
  history, archived to `.tanya/runs/<runId>/reasoning.jsonl`, shown as separate
  events, and protected by reasoning-token caps.
- Added reasoning token accounting in `/cost` and `/budget`, `/memory
  --reasoning`, opt-in advisory verifier annotations, and REPL/JSONL/Cosmo
  reasoning UX controls including `TANYA_HIDE_REASONING`.

## [0.10.0-beta.0] - 2026-05-16

### Added

- Added bidirectional MCP support: Tanya can consume configured external MCP
  servers as `mcp:<server>:<tool>` tools, and `tanya mcp serve` exposes
  `tanya.verify`, `tanya.golden_task_search`, `tanya.run`, and
  `tanya.skills_list` over MCP stdio.
- Added MCP config loading from `~/.tanya/mcp.json` and project `.tanya/mcp.json`,
  `/mcp` server status, MCP permission/audit integration, transport restart and
  timeout handling, recursion guard, schema validation, and MCP docs/examples.

## [0.9.0-beta.0] - 2026-05-16

### Added

- Added opt-in multi-model routing with route-table schema, provider/model
  defaults for cheap planning/tool-call turns and capable synthesis/verifier
  turns, context-window guards, observable `model_routed` events, provider
  fallback, per-tool preferred models, sub-agent model pins, capped
  `escalation_event` fallback, and the `/route` REPL command.

## [0.8.0-beta.0] - 2026-05-16

### Added

- Added the `task` sub-agent tool with inherited context, tighten-only
  permission rules, scoped workspaces, budget-ledger accounting, recursion and
  cycle guards, cancellation propagation, verifier composition, and parent-only
  golden-task memory rollups.

## [0.7.0-beta.0] - 2026-05-16

### Added

- Added token-economy controls for cheap-provider sessions: opt-in lite system
  prompts, automatic prompt-budget enforcement from provider context windows,
  reversible large tool-result truncation through `expand_result`, per-run
  result caches, file-read deduplication, and the `/budget` reporter with
  spend-rule enforcement.
- Added the token-economy reference docs and benchmark evidence: a synthetic
  10-task fixture reduced input tokens by 77.5% with 0% verifier-verdict
  regression, while the golden suite stayed at 27/27 with zero drift.

## [0.6.0-beta.0] - 2026-05-16

### Added

- Added opt-in permission modes (`bypass`, `default`, `ask`, `plan`) with
  user/project rules, REPL approval prompts, learned allow/deny rules, audit
  logging, `/audit`, `/mode`, and project-local command gating.
- Added spend rules for projected token/USD budgets plus `/cost --enforce` and
  the `/budget --enforce` M5.5 stub.

## [0.5.0-beta.0] - 2026-05-16

### Added

- Added reactive context compaction for long sessions: typed context-window
  errors, microcompact, low-signal snipping, forked auto-compaction retry,
  archive-backed auditability, compaction events, and a compaction-boundary
  golden task.

## [0.4.0-beta.0] - 2026-05-16

### Added

- Added provider robustness adapters for DeepSeek, Qwen, Grok, Groq, Together,
  Ollama, and OpenAI-compatible APIs, with permissive tool-call parsing, schema
  flattening, retry/throttle events, and mock conformance tests.

## [0.3.0-beta.0] - 2026-05-15

### Added

- Added interactive slash commands for clearing chat history, inspecting skill
  packs, verifier output, run costs, golden-task memory, help, and project-local
  command extensions.

## [0.2.0-beta.0] - 2026-05-15

### Added

- Added OSS launch scaffolding: contributor, conduct, security, issue template,
  PR template, CI, release workflow, and example documentation.
- Added curated `good first issue` onramp tasks for slash commands and skill
  packs.

### Changed

- Sanitized prior-art documentation to rely on public sources only.
- Polished npm package metadata and publish allowlist for the beta package.

## [0.1.0] - 2026-05-15

### Added

- Added streaming `run_shell` progress events, CLI/Cosmo/JSONL sink support,
  and active-tool cancellation with partial output returned in the final tool
  result.
