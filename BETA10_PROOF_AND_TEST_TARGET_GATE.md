# Tanya beta.10 — prove the gates bite, then close the test-target gap

> Prompt for an agent working in THIS repo (`/Users/matheus/Desktop/Projetos/Appzinhos/tanya`). Follow-up to `docs/gate-escape-2026-07-13.md` (root cause: `!interactive` disarmed every gate) and its fix `2dfb044` / release `5043a19` (0.17.1-beta.10). The dist was rebuilt 2026-07-14 ~11:15 so the npm-linked binary now runs beta.10 — but the fix has never been proven against a live run, and the same day's CosmoKit audit exposed one more verification gap. Two tasks.

## Task 1 — Canary: prove a gate-violating task run now FAILS

Build a throwaway fixture and run the REAL linked `tanya` binary against it end-to-end:

1. Create a temp git repo (e.g. under `/tmp/tanya-canary`) with a trivial compiled project (a Swift package or Go module — pick whichever the clean-tree gate supports best) and an initial commit.
2. Through the same entry point the mac app uses (interactive task turn — this is the path that used to bypass everything; check how the mac app invokes runs and replicate it, or use the closest CLI equivalent with `interactive:true`), give it a deliberately gate-violating task: a prompt with 3 numbered deliverables and a `## Verify` section, where the work plan will (a) create a new source file and NOT commit it, (b) skip one numbered deliverable entirely, (c) not run the Verify command.
3. **Expected with beta.10:** the run's final verdict is FAILED, naming: the untracked/uncommitted paths (commit-completeness), the unexecuted Verify command (verify-gate), and the missing deliverable (spec-coverage). If ANY of those three does not surface, that's a live bug in `2dfb044` — fix it and re-run the canary until all three appear.
4. Record the canary transcript (prompt, verdict, gate findings) in `docs/gate-canary-2026-07-14.md`, and turn the canary into an automated integration test if the harness supports spawning a full run; otherwise document the manual repro steps in the same doc.
5. Clean up the fixture repo.

## Task 2 — Close the test-target verification gap (new evidence, same day)

Fresh escape shape from the CosmoKit FIX3 run (commit `c7bf7b9` in `cosmohq-project/CosmoKit/CosmoKit`): the run faithfully executed its mandated verification — `xcodebuild … build` on a clean worktree, `** BUILD SUCCEEDED **` — and still shipped a commit where the **unit-test target does not compile** (`SimulatorDevice.init` gained a required parameter; 7 call sites in `CosmoKitTests/` still use the old signature). Plain `build` does not compile test targets, so the check was honest but blind.

Fix in the clean-tree build gate (from `4270349`, now intent-gated via `taskGating.ts`):

1. When the gate builds a checked-out tree, prefer the variant that compiles tests WITHOUT running them, per language:
   - Xcode: `xcodebuild … build-for-testing` when the scheme has a test action (fall back to `build` if it doesn't).
   - Go: `go build ./... && go vet ./...` plus compile tests via `go test -run '^$' -count=1 ./...` (compiles test files, runs nothing).
   - npm/tsc: the existing typecheck/build already covers test sources when they're in the tsconfig — verify, and include the test tsconfig if separate.
2. Same upgrade wherever the DoD/verify machinery synthesizes a default build command for a repo.
3. Regression test with a fixture reproducing the CosmoKit shape: library code changes a signature, a test file keeps the old call — plain build passes, the gate must still FAIL.

## Conventions

Existing test framework; update `CHANGELOG.md`; bump version per repo convention; `npm run build` + full suite green; **rebuild dist at the end so the linked binary ships the change — verify by mtime** (a stale dist is how beta.9's gates sat dormant for a whole night); path-limited commits; no push.
