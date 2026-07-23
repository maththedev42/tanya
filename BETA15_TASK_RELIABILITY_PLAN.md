# Tanya beta.15 — task-reliability round (plan; build with Opus/Sonnet)

> Prompt for an agent working in THIS repo (`/Users/matheus/Desktop/Projetos/Appzinhos/tanya`),
> currently `0.17.1-beta.14` on `main`. Planned 2026-07-17 from three live stalls observed
> 2026-07-14..16; every file/line anchor below was verified against beta.14 — trust them
> before re-deriving. Four parts, ordered by leverage. Purely additive to the gate system:
> **do not change when gates arm or how they judge** — Parts 1–4 prevent stalls and steer
> the model; only Part 1's finalize step may reclassify one narrow blocker shape, under a
> worktree-verified proof.

## Evidence (why these four)

Three real stalls, each a different class:

| # | Stall (verbatim shape) | Class | Status at beta.14 |
|---|---|---|---|
| 1 | `grep … 2>&1 -> failed (Shell exited 1.)` | no-match exit 1 misread | FIXED (beta.13 `stripTrailingRedirects`) |
| 2 | `grep -v "…struct\|`json" …` | model wrote unparseable command | labelled (beta.14 `isShellParseError`) but not prevented |
| 3 | `go test ./internal/... -> failed` | **pre-existing red test unrelated to the task** | UNHANDLED — cost a full session |

Stall 3 diagnosis (cosmohq-v3): commit `021c8a6` added a `GET /reviewSubmissions/{id}/items`
call (`internal/store/apple/versions.go:334` → built at `:693`) to `SubmitForReview` without
updating the strict test mock (`client_test.go` handles only `POST /reviewSubmissionItems`,
falls through to `t.Errorf("unexpected request…")`). Four `TestSubmitForReview_*` tests are
red **at HEAD**, in a package the agent's task never touched. The agent ran the broad
`go test ./internal/...`, hit them, and ground to the stall detector.

Underlying all three: the agent's searches used `"a|b|c"` with **plain grep** (literal pipe —
silent wrong-shaped search), and it retried near-identical variants that the exact-label
repeated-failure guard (`runner.ts` `REPEATED_FAILURE_ATTEMPT_LIMIT = 3`, guard at
`runner.ts:~2500-2522`, keyed by exact `label` + `mutationRevision`) never caught.

---

## Part 1 — Baseline-aware verification (the "someone else's red test" killer)

Two layers: a cheap early nudge that prevents the stall, and a rigorous finalize check that
keeps the report honest. **Go-first** (the observed class); other ecosystems explicitly out
of scope this round — note that in the module doc.

### 1a. Early nudge (tool-result augmentation)

New module `src/agent/baselineFailures.ts`:

- `parseGoTestFailures(output: string): string[]` — failing package paths from
  `^FAIL\s+(\S+)` lines (also tolerate `--- FAIL:` blocks with a following `FAIL\tpkg`).
- `isBroadGoTestCommand(script: string): boolean` — `go test` whose package args contain
  `...`. Reuse the cd-prefix/redirect strippers from `src/tools/fsTools.ts`
  (`stripTrailingRedirects`, the cd-hop regex in `isBareSearchInvocation`) — export or
  duplicate minimally; don't re-invent.
- `packagesTouchedByRun(changedFiles: string[]): string[]` — dirs of changed `.go` files,
  module-relative (`internal/coding/store.go` → `internal/coding`).
- `untouchedFailingPackages(failing: string[], touchedDirs: string[]): string[]` — failing
  packages whose module-relative dir is NOT touched. Go package paths in `FAIL` lines are
  module paths (`github.com/x/api/internal/store/apple`); match by **suffix** against
  touched dirs.

Wiring: in the runner's tool-result path where the verification line is built
(`runner.ts:2635` — `Verification: ${label} -> failed (${result.summary})`), when a failed
`run_shell`/`run_command` result is a broad go-test AND `untouchedFailingPackages(...)` covers
**all** failing packages, append to the tool result output (model-visible, like the
repeated-failure advisory at `runner.ts:~2510`):

> The failing package(s) `<pkgs>` were not touched by this run — this is likely a
> pre-existing failure. Do NOT fix unrelated packages. Re-run scoped to what you changed
> (e.g. `go test ./internal/coding/...`); if the scoped run passes, state the pre-existing
> failure in your report instead of retrying the broad command.

The runner knows changed files via the mutation write-log it already tracks for
`collectChangedFiles`/commit gate — use that, not git status.

### 1b. Finalize-time reclassification (rigorous, narrow)

In `src/agent/report.ts` `buildFinalManifest`, after blockers assemble (near the stale-failure
filter at `report.ts:~336`): for each `failed verification:` blocker whose command is a broad
go-test where 1a's analysis says all failing packages are untouched:

1. Run the same test command **scoped to the failing packages only** at
   `manifest.sessionBaseHead` (set at `report.ts:313`) in a throwaway worktree — reuse the
   worktree pattern from `src/agent/cleanTreeBuild.ts` `runCleanTreeBuild`/`cleanupWorktree`
   (`cleanTreeBuild.ts:102,134`); factor a shared helper rather than copy-pasting.
2. **Fails at base too** → the failure pre-exists: remove the blocker, add a report line
   `Pre-existing test failure (verified at base <shortsha>): <pkgs> — unrelated to this run.`
   and record it in the structured gates section (`src/agent/gateReport.ts`): add an optional
   `baseline?: { status: "pre-existing" | "introduced" | "inconclusive"; packages: string[]; baseHead: string }`
   to `GateReport` and write it into the archive (archive stays `archiveVersion: 2` — the
   field is optional/additive).
3. **Passes at base** → this run broke it: KEEP the blocker (append `— introduced by this
   run (passes at base <shortsha>)`).
4. Baseline run errors/times out (cap ~5 min) → **inconclusive: keep the blocker.**
   Fail-closed, never fail-open.

Strict containment rules — never reclassify when:
- any failing package intersects the touched set;
- the command is a prompt-`## Verify` required command that the verify-gate needs
  (`report.ts` verify-gate block, `gatesArmed && … verifyGate !== false`) **unless** the
  scoped-to-touched-packages run passed this session — in that case the verify-gate accepts
  the evidence WITH the pre-existing note (the gate's intent is "your change is verified",
  not "you fixed the whole repo");
- `sessionBaseHead` is absent.

### Tests (fixture pattern of `gateCanary.test.ts` / `cleanTreeBuild.test.ts`: tmpdir git repo)

- Fixture Go module with two packages: `good/` (task touches it) and `broken/` (test red at
  the base commit). Run finalize with a failed broad-test blocker → blocker reclassified,
  report carries the pre-existing line, `gates.baseline.status === "pre-existing"`.
- Same fixture but the run's change breaks `broken/` (it passed at base) → blocker KEPT with
  "introduced" note.
- Failing package == touched package → untouched analysis empty → nothing reclassified.
- Baseline worktree command times out → blocker kept, `baseline.status === "inconclusive"`.
- Unit tests for `parseGoTestFailures` / `packagesTouchedByRun` / suffix matching.

---

## Part 2 — Classified stall messages (interface)

Finding (verified): the `Stuck on:` detail (`runner.ts:2775-2778`) slices the last failing
verification line, and that line **already embeds the classified tool summary**
(`runner.ts:2635` puts `result.summary` in the parenthetical). So beta.13's
"no matches" and beta.14's "Shell parse error — the command was NOT executed…" already
reach the mac-app pause message. Remaining work:

1. Part 1a's pre-existing analysis must reach `result.summary` too (not only the output
   body) so `Stuck on:` shows `… -> failed (pre-existing failure in internal/store/apple —
   not caused by this run)` instead of `(Shell exited 1.)`.
2. Keep the detail single-line and ≤400 chars (the existing slice); classification first,
   exit code last.
3. End-to-end test: extend `interactiveRun.test.ts` (or a new `stallDetail.test.ts`) — drive
   `runAgent` with a provider that loops a failing parse-error command until the stall stop,
   assert the final message's `Stuck on:` line contains "parse error" / "NOT executed", and
   (second case) the pre-existing classification. No serveStdio/mac-app change should be
   needed — assert at the runner-message level.

---

## Part 3 — Search-semantics nudge (literal `|` in plain grep)

In `src/tools/fsTools.ts`, `searchNoMatchResult()` (~line 269) currently returns a fixed
message. Change it to accept the script and append, ONLY when all of:

- binary (after cd-strip + redirect-strip) is `grep`/`zgrep`/`fgrep` — NOT `egrep`, `rg`,
  `ag` (alternation is default there);
- no `-E` / `--extended-regexp` / `-P` flag present (and note `fgrep`/`-F` are always
  literal);
- the quoted pattern contains an unescaped `|`;

the line:

> Note: the pattern contains `|`, which plain grep matches as a LITERAL pipe character —
> if you meant alternation (a OR b), re-run with `grep -E`.

This intentionally overrides the "do not re-run the same search" guidance with a concrete
better next step — keep both sentences.

Tests (extend `src/tools/__tests__/runShell.test.ts`, "search exit semantics" describe):
- plain `grep "a|b"` no-match → hint present;
- `grep -E "a|b"` no-match → no hint;
- `rg "a|b"` no-match → no hint;
- `grep "plain"` (no pipe) no-match → no hint.
- The exact stall-1 command shape (`grep -rn "launchStep|LaunchStep|…" dir --include="*.go" 2>&1`)
  → hint present (proves composition with `stripTrailingRedirects`).

---

## Part 4 — Near-duplicate retry breaker

The existing guard (`runner.ts:~2500-2522`) keys `repeatedFailureAttempts` by the exact
`label`, so `grep "a|b" dir1` → `grep "a|b|c" dir1` → `grep -rn "a|b" dir2` each get a fresh
count. Widen with a SECOND fingerprint map (keep the exact-label one untouched):

- `failureFingerprint(label, output)` = normalized binary (cd-strip + redirect-strip, reuse
  Part 1's helpers) + `sha1(normalized failure output)` (trim, collapse whitespace; the
  observed loops had byte-identical output — do NOT get clever with fuzzy matching).
- Same re-arm semantics as the existing guard: reset on `mutationRevision` bump.
- On the 3rd failure with the same fingerprint (reuse `REPEATED_FAILURE_ATTEMPT_LIMIT`),
  do NOT skip the command (that stays the exact-label guard's job) — append a
  strategy-change nudge to the failed result output + one `status` sink message (mirror
  `repeatedFailureAdvisorySent`):

> Third failure with effectively the same command and identical error. Stop retrying
> variants. Change approach: read the file directly, use the dedicated grep/read tools,
> scope the command differently, or record the blocker and continue.

Tests: three near-identical failing greps (varying flags/pattern, same output) → third
result carries the nudge; a *different* failure output resets nothing false-positively; a
file mutation between failures re-arms.

---

## Verify (all must pass before calling it done)

1. `npx tsc --noEmit` clean; full `npx vitest run` green (baseline at beta.14:
   1189 passed / 1 skipped — `serveStdio.test.ts` has a known parallel-load flake; re-run
   before concluding a regression).
2. New tests per part (named above) present and green; `gateCanary.test.ts` still FAILs its
   violating fixture — **prove no gate got weaker**.
3. Scripted end-to-end of the stall-3 shape (Part 1 fixture) shows: early nudge in the tool
   result, no stall, finalize report carrying the pre-existing line, archive
   `gates.baseline` populated.
4. `CHANGELOG.md` entry + `npm version 0.17.1-beta.15 --no-git-tag-version`.
5. `npm run build`; verify `dist/BUILD_ID.json` shows beta.15 and a fresh `builtAt`; grep a
   new symbol (e.g. `parseGoTestFailures`) into the shipped chunk.
6. Path-limited commits on `main` (feature / tests / release-docs split like beta.12's
   `944e64a`/`0ec7d33`/`68b8116`); **no push**.
7. To make it live in the mac app: `osascript -e 'quit app "Tanya"'`, kill any orphaned
   `tanya serve --stdio` (they survive app quit when grinding — `pgrep -f`), then `open
   apps/macos/build/dd/Build/Products/Release/Tanya.app` (rebuild via
   `apps/macos/scripts/dev-build.sh` only if the .app is missing). Verify the serve child's
   start time is newer than `dist/BUILD_ID.json` `builtAt`.

## Guardrails

- Parts 2–4 are pure observability/steering: no verdict, blocker, or arming change.
- Part 1b is the ONLY behavior change to blockers, and only under: all failing packages
  untouched AND worktree-confirmed failing at `sessionBaseHead` AND fail-closed on any
  doubt. A failure in a touched package can NEVER be reclassified.
- `exactOptionalPropertyTypes` is on — optional params as `T | undefined`, spread-style
  optional object fields (see `taskGating.ts` for the house pattern).
- Match existing test harness (vitest, tmpdir fixture repos with `git init -q` + gpgsign
  off — copy `gateCanary.test.ts`'s `canaryRepo()` shape).
- Archive writes stay best-effort; never fail a run from new code paths.
