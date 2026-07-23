# Gate canary — 2026-07-14

Live proof that the beta.10 intent-gating fix (`2dfb044`, root cause in
`docs/gate-escape-2026-07-13.md`) actually FAILS a gate-violating task run on the
**interactive path** — the path the mac app uses and the one that used to bypass
every gate. Automated as `src/agent/__tests__/gateCanary.test.ts`.

## What the canary does

Drives the real `runAgent(..., { interactive: true })` — the same entry the mac
app's stdio backend calls — against a temp git repo and a deliberately
gate-violating, task-shaped prompt (3 numbered deliverables + a `## Verify`
section). A deterministic mock provider (no network) makes the run:

- **(a)** write a new source file `src/feature.swift` and never commit it,
- **(b)** address only Part 1 + Part 2 in its report (drop Part 3),
- **(c)** never run the required `npm test` verify command.

## Expected — and observed — with beta.10

The final verdict is **`TANYA RESULT: FAIL`**, and `manifest.blockers` names all three:

| Gate | Blocker (observed) |
|---|---|
| commit-completeness | `Commit incomplete: … src/feature.swift … git add the exact paths and commit them.` |
| spec-coverage | `Spec coverage incomplete: 1 required deliverable(s) not accounted for — Part 3.` |
| verify-gate | `Verify step(s) not executed with passing evidence: \`npm test\`.` |

`manifest.gateLog` (also written to the run archive):
`["armed=true interactive=true codingTask=true", "commit-completeness: FAIL (1 uncommitted)", "verify-gate: FAIL (1 unrun)", "spec-coverage: FAIL (1 pending)"]`

A top-level run archive is written under `<repo>/.tanya/runs/*.json` with
`"verdict": "FAIL"` and the blockers recorded.

## Bug the canary caught (and this change fixes)

On the first canary run, **commit-completeness did NOT fire** even though the file
was uncommitted. Root cause: `git status --porcelain` collapses a *new untracked
directory* to `src/` instead of listing `src/feature.swift`, so a file the run
created in a fresh directory never matched the mutation write-log — the exact
E1/E6 shape (a new source file under a new package dir). Fixed by adding
`--untracked-files=all` to `dirtyPathsInRepo` (git.ts), so untracked files are
listed individually. The canary is now green.

## Reproduce

```
npx vitest run src/agent/__tests__/gateCanary.test.ts
```

The fixture repo is created under the OS temp dir and is self-cleaning (vitest
temp dirs); nothing is left in the tree.
