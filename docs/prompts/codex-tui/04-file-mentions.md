# Task: @file mention autocomplete (Codex-style)

You are working in the Tanya repo (`<repo-root>`),
a TypeScript ESM CLI (Node ≥20) with an Ink 5 + React 18 TUI. Branch:
`feat/tui-04-file-mentions`. **Prerequisites:** package 01 (multi-line composer on
`src/ui/ink/composer/`); if package 03 (CommandPopup) has landed, reuse its popup
component/pattern rather than inventing a new one.

## Deliverable

Typing `@` in the composer opens a file-search popup for the current project:

- **Candidate list:** prefer `git ls-files --cached --others --exclude-standard`
  (respects `.gitignore`); fall back to a bounded fs walk (skip `node_modules`,
  `.git`, `dist`, `build`, dot-dirs; cap at ~5,000 entries) when not a git repo.
  Build the index lazily on first `@` and cache it for the session; refresh when the
  popup opens and the cache is older than ~30 s. All paths relative to the chat cwd.
- **Filtering:** fuzzy subsequence match on the text typed after `@`, ranked by
  (match on basename > match on path, shorter paths first). Show ≤ 8 rows.
- **Keys:** ↑/↓ select; Tab/Enter inserts the relative path in place of the `@query`
  token (plain text — Tanya's agent already reads files given a path in the prompt);
  Esc closes and keeps the typed text; a space or path-terminating character closes
  the popup. Multiple mentions per message must work; `@` mid-buffer works (token
  starts at the `@` nearest left of the cursor).
- Mentioned paths in the composer render cyan (display-only; submitted text is plain).

Put the index/scan logic in `src/ui/ink/composer/fileIndex.ts` (pure/async, injected
exec + fs so it's testable) and the UI in `src/ui/ink/MentionPopup.tsx` (or reuse a
generic popup shared with CommandPopup — your call, keep it DRY).

## Constraints

- Never block the render loop on the scan — first paint of the popup may show
  "indexing…" and fill in.
- Respect the `React.memo` + stable-refs perf contract (see `Input.tsx` comment).
- Popup renders in the non-static region only (Ink `<Static>` history must not
  re-render).
- No new runtime dependencies for fuzzy matching — write the ~30-line scorer.

## Tests (vitest + ink-testing-library)

- `fileIndex` unit tests with stubbed `git ls-files` output and a temp-dir fs walk
  (gitignored files excluded via the git path; caps honored).
- Scorer tests: basename beats path match; ordering is stable.
- Component tests: type `@inp` → `src/ui/ink/Input.tsx` listed; Enter inserts the
  path; two mentions in one message; Esc keeps text.
- `npm run typecheck && npm test` must pass.

## Done means

In `npm run dev -- chat`, `@` pops file search, `@foot⏎` inserts
`src/ui/ink/Footer.tsx`, and the submitted message contains the plain path. Commit
only the files you touched (conventional commit); do not push.
