# Task: Slash-command autocomplete popup (Codex-style)

You are working in the Tanya repo (`<repo-root>`),
a TypeScript ESM CLI (Node ≥20) with an Ink 5 + React 18 TUI. Branch:
`feat/tui-03-slash-popup`. **Prerequisite:** package 01 (multi-line composer built on
`src/ui/ink/composer/`) has landed.

## Context

- Slash commands are registered in `src/commands/registry.ts` (`listCommands()`
  returns `{ name, description, category, … }`), including project-local commands
  loaded from `.tanya/commands/*` by `src/commands/project.ts` (App loads them on
  boot). Dispatch happens in `App.tsx` → `dispatchInteractiveCommand`
  (`src/agent/chat.ts`) when a submitted message starts with `/`.
- `src/ui/ink/SessionPicker.tsx` is an existing arrow-key selection component —
  follow its style and its focus conventions in `App.tsx` (while a picker is open,
  the composer is disabled via the `disabled` prop).

## Deliverable

When the composer buffer starts with `/` (and contains no space yet), render a popup
directly above the input box:

- Lists matching commands: `/name` left column, description right column, dimmed;
  filter is fuzzy-ish (subsequence match is fine) on the text after `/`, case-
  insensitive; show at most 8 rows with a scroll indicator when more match.
- ↑/↓ move the selection (these keys go to the popup while it is open, not to
  buffer-line movement or history); Tab or Enter completes the selected command into
  the buffer (`/name ` with trailing space when the command takes arguments — if the
  registry can't tell, always append the space); Enter on an exact, argument-free
  completion may submit directly (match Codex: complete first, second Enter submits).
- Esc closes the popup and leaves the typed text; typing continues filtering;
  the popup disappears when the buffer no longer starts with `/` or contains a space.
- Project-category commands are visually tagged (e.g. dim `[project]` suffix).

Keep the popup logic in a new `src/ui/ink/CommandPopup.tsx` plus a pure filter
helper in `src/ui/ink/composer/filterCommands.ts` so it is testable without Ink.

## Constraints

- Don't break the `React.memo` + stable-refs perf contract; popup state should live
  alongside the composer, not force full-App re-renders per keystroke.
- Don't change dispatch semantics: submission still sends the raw string to
  `dispatchInteractiveCommand` exactly as today.
- Layout: the popup must not corrupt `History` (which uses Ink `<Static>`) — render
  it inside the non-static region only.

## Tests (vitest + ink-testing-library)

- Pure tests for `filterCommands` (ordering, subsequence matching, empty query).
- Component tests: type `/he` → popup lists `/help`; Tab completes; Esc dismisses;
  ↑/↓ selection wraps or clamps (pick one, test it); popup absent once a space is typed.
- `npm run typecheck && npm test` must pass.

## Done means

In `npm run dev -- chat`, typing `/` immediately shows the command menu with
descriptions, arrow keys + Tab complete, and `.tanya/commands/*` entries appear
tagged. Commit only the files you touched (conventional commit); do not push.
