# Tanya Reliability Hardening — make task runs fail loudly instead of lying quietly

> Prompt for an agent working in THIS repo (`/Users/matheus/Desktop/Projetos/Appzinhos/tanya`). Goal: turn six observed, recurring failure modes into **mechanical gates** so Tanya cannot report success while work is missing, uncommitted, or unreachable. `npm run build` ships live via npm link, so everything must land behind tests.
>
> Evidence base: a 10-prompt implementation series Tanya ran on CosmoKit (2026-07-13, audit in `cosmohq-project/CosmoKit/COSMOKIT_CONVERSION_TANYA_FIX_PROMPTS.md`), plus a recurring pattern first seen on CosmoRemote Android (2026-07-12, same miss-shape twice). Scorecard of the CosmoKit run: 4 of 10 prompts **silently skipped**, 1 half-done and left uncommitted, 2 of 5 committed prompts shipped blockers. Every run self-reported success.

---

## The failure taxonomy (each becomes a gate)

**F1 — Silent task skipping.** Given 10 sequential prompts, Tanya executed 6 and never mentioned the other 4 (no error, no "skipped"). The orchestrating human only discovered it via `git log`.

**F2 — Broken committed trees / untracked dependencies.** Tanya committed `GettingStartedView.swift` (which references `GettingStartedManager.shared`) while `GettingStartedManager.swift` sat **untracked** in the working tree. Every clean checkout from that commit to HEAD fails to compile; Tanya's "green build" was only green because the uncommitted file was present locally. Third occurrence of this exact shape (CosmoRemote: untracked `strings_tests_parity.xml` + uncommitted `MainScreen.kt` wiring, twice).

**F3 — Cross-task staging contamination.** That smuggled file belonged to a *different* prompt (TANYA-03) than the commit it rode in on (TANYA-06), along with 5 enum cases nothing committed ever emits. Commits must contain exactly the current task's files.

**F4 — Partial spec execution, worst in localization.** Two tasks introduced ~25 user-facing `L10n.tr` strings with **zero** entries in the four `Localizable.strings` files, despite the spec's explicit "add all four" constraint. Also: a specced `onboarding_shown` analytics event was declared but never emitted; the checklist window was built but never wired into the launch path (dead code — the feature's entire purpose).

**F5 — Dead-looking-alive code.** A "Reveal in Finder" button shipped as `NSWorkspace.shared.activateFileViewerSelecting([])` — a no-op that looks implemented. A trial-countdown feature shipped gated on `!isPro` when the value it displays only exists while `isPro == true` — a condition that can never be true, so the feature never renders. Both pass compilation and casual review.

**F6 — Invented external facts.** Tanya hardcoded `exitCode == 146` + stderr `"already booted"` as simctl's already-booted signature. The real behavior is stderr `Unable to boot device in current state: Booted` (different code). Never verified, just plausible-sounding.

---

## What to build

Explore `src/agent/` first — the relevant machinery already exists: `dodGate.ts` (Definition-of-Done runtime gate), `acceptanceCriteria.ts`, `report.ts`, and the commit gate (see root `COMMIT_GATE_FIX_PROMPT.md` for its history; it currently ensures *a* commit happens, but not that the commit is *complete*). Integrate with these rather than building parallel systems. For each gate below: implement, unit-test, and wire into the run lifecycle so failing the gate blocks the SUCCESS verdict (self-clearing where noted, in the spirit of the existing DoD gate).

### G1 — Spec Manifest gate (kills F1, F4)
At task start, extract the numbered/bulleted requirements from the prompt into a persistent manifest (id, quoted requirement, status: pending). The final report must mark every item `done` (with a one-line evidence pointer: file:line, commit sha, or command output) or `skipped` (with a stated reason). `report.ts` refuses a SUCCESS verdict while any item is `pending`, and renders skipped items prominently. For multi-prompt/queued runs: a queue summary listing every prompt with executed/skipped status — a prompt that was never started must be impossible to omit from the summary.

### G2 — Commit-completeness gate (kills F2, F3)
Extend the commit gate so that after the end-of-task commit:
- `git status --porcelain` filtered to paths the session **created or edited** (track these from the tool-call log — Tanya already knows every file it wrote) must be empty. Untracked new files or unstaged edits to session-touched paths = gate failure with the exact paths listed.
- **Clean-tree compile check:** rebuild from the committed tree, not the dirty worktree — `git stash -u` + build + `git stash pop`, or a temp `git worktree add` of HEAD (pick per repo size; make it configurable, default on for compiled languages). This is the only check that would have caught the CosmoKit broken tree — the working-tree build lied.
- **Staging scope:** warn (configurable: fail) when the commit contains files the current task never touched, comparing the commit's file list against the session's write-log.

### G3 — Localization gate (kills the F4 recurrence)
Repo-configurable rule (auto-detect when a `*.lproj/Localizable.strings` set or `values*/strings.xml` set exists): diff the task's changes for new localization keys (`L10n.tr("…")` / `NSLocalizedString` / `stringResource`), then verify each key exists in **every** sibling locale file. Missing locales = gate failure listing key × missing-file pairs. This is a pure grep — cheap, zero false-positive space, and it has now failed twice in production.

### G4 — Reachability / liveness self-review (mitigates F5)
Cheap static checks + one targeted review pass before the commit:
- Any **new enum case / event constant** added by the task must have ≥1 non-declaration reference in the committed tree (grep). Declared-but-never-emitted analytics events have now shipped twice.
- Any **new UI action handler** whose body contains no state mutation, no service call, or passes empty/constant arguments to a system API (the `activateFileViewerSelecting([])` shape) → flag for the review pass.
- Feed flagged sites into a single focused self-review turn with the question: "State the concrete user path that reaches this code and the visible effect. If you cannot, it is dead — fix or remove." The existing DoD runtime gate should treat a flagged-unresolved site like an unverified behavior (nudge tier, not hard fail — same self-clearing philosophy).

### G5 — External-fact verification rule (kills F6)
Prompt-level rule in the system prompt + a lint in the review pass: when code branches on an **external tool's behavior** (exit codes, stderr strings, API error shapes), Tanya must either (a) verify empirically in-session (run the tool, cite the observed output in the report) or (b) code defensively (match the broadest safe condition, log the unmatched case) AND record the assumption as an explicit `ASSUMPTION:` line in the final report. Bare hardcoded exit codes / error-string matches with neither = review-pass flag.

### G6 — Report honesty invariants (backstop for everything)
`report.ts`: a SUCCESS verdict must be impossible when any gate above failed; the report template gains mandatory sections — Spec Manifest table, commit SHA(s) + `git show --stat`, gate results, `ASSUMPTION:` list. If the runner dies mid-queue, the partial-queue state must surface in whatever summary the caller sees (never a silent truncation).

---

## Constraints

- Follow existing repo conventions (see `TANYA.md`, `docs/repo-map.md`); TypeScript, existing test framework; gates configurable per-repo like the DoD gate, **default ON for ad-hoc runs** (same decision as commit 6d1472a for the commit gate).
- Self-clearing over blocking: hard-fail only on objective facts (untracked session files, missing locale keys, pending manifest items); use nudge/review tiers for heuristics (G4, G5) so a working app is never false-failed — same philosophy as the DoD runtime gate.
- Unit tests for every gate (fixture repos/diffs for G2/G3 are fine); `npm run build` + full test suite green.
- Update `CHANGELOG.md`; bump version per repo convention.
- Commit in logical increments, path-limited staging (do not sweep unrelated WIP). Do not push.

## Acceptance (prove it on the real evidence)

Reproduce each failure in a test using the CosmoKit shapes: (1) a 3-item manifest with 1 item pending → SUCCESS blocked; (2) a fixture repo where a committed file references an untracked one → G2 clean-tree build fails and names `GettingStartedManager.swift`; (3) a diff adding `L10n.tr("Get Set Up")` with the key present only in `en.lproj` → G3 lists the 3 missing locales; (4) a diff adding an enum case with no second reference → G4 flags it; (5) a diff containing `exitCode == 146` with no verification or ASSUMPTION line → G5 flags it. All five must fail before your change (red) and be caught after (green).
