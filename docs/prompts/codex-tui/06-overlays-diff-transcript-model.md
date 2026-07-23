# Task: Overlay framework + /diff, Ctrl+T transcript, /model picker

You are working in the Tanya repo (`<repo-root>`),
a TypeScript ESM CLI (Node ≥20) with an Ink 5 + React 18 TUI. Branch:
`feat/tui-06-overlays`. Independent of the composer packages — safe to run in
parallel with them (touch `App.tsx` minimally to reduce merge friction).

## Context (read first)

- `src/ui/ink/App.tsx` — layout: History (Ink `<Static>` — append-only), then
  ActivityPanel / PermissionPrompt / SessionPicker / Input / Footer in the live region.
- Slash commands: registered in `src/commands/registry.ts` + built-ins under
  `src/commands/builtin/`; dispatched via `dispatchInteractiveCommand`
  (`src/agent/chat.ts`) which receives an options bag from `App.tsx` (see how
  `openSessionPicker` is threaded through — mirror that pattern for opening overlays).
- Provider/model wiring: `createProvider` in the CLI layer, routing config in
  `src/router/` and `docs/routing.md`, provider quirks in `docs/providers.md`.
  `Footer.tsx` shows `provider.id` + `provider.model`.

## Deliverables

1. **Overlay framework.** A full-width scrollable pane that replaces the live region
   (History stays; ActivityPanel/Input hidden while open): `↑/↓` line scroll,
   `PgUp/PgDn`/`Ctrl+U/D` page scroll, `g/G` top/bottom, `q`/Esc closes. One overlay
   at a time; permission prompts take priority (an incoming permission request closes
   the overlay). Implement as `src/ui/ink/Overlay.tsx` + reducer state in
   `state.ts` (`overlay: { title, lines } | null` or a small variant union).
2. **`/diff` command.** New built-in slash command that shows the working-tree diff
   of the chat cwd in an overlay: `git diff` + `git diff --cached` + a short
   untracked-files section (`git status --porcelain`). Color added/removed lines
   green/red (map `+`/`-` prefixes; no dependency on git color codes). Outside a git
   repo, show a friendly message. Run git via the repo's existing subprocess helper
   if one exists (search `src/utils/` and `src/tools/` first) — don't shell out with
   string interpolation.
3. **Ctrl+T transcript overlay.** Renders the full session so far — every message in
   `state.messages` (uncla mped) plus activity summaries with their status/elapsed —
   so long tool outputs clamped in History can be reviewed. Reuse the markdown
   renderer (`src/ui/ink/markdown.tsx`) where sensible.
4. **`/model` picker.** Slash command that opens a selection overlay listing the
   models available from the current provider config/routing tables (inspect
   `src/router/` for what is enumerable; list at minimum the configured default +
   any routing-table models). Selecting one switches the model used for subsequent
   turns in this session and updates the Footer. If a clean session-scoped switch
   hook doesn't exist, add the smallest one (e.g. a `setModel` on the provider or a
   session override threaded into `runAgent` options) — document the choice in the
   commit message. Persisting the choice beyond the session is out of scope.

## Constraints

- Never render inside `<Static>` from the overlay; History must not re-render.
- Keyboard focus rules: while an overlay is open the composer receives no input.
- `/diff` and Ctrl+T must handle huge content (10k+ lines) without freezing —
  virtualize by slicing to the viewport in the Overlay component.

## Tests (vitest + ink-testing-library)

- Overlay: scroll clamping, `q` closes, permission request closes it.
- `/diff`: stub the git runner; colored added/removed lines; non-repo message.
- Transcript: long message not clamped; activity rows include status.
- `/model`: reducer/selection test with a stubbed provider; Footer reflects switch.
- `npm run typecheck && npm test` must pass.

## Done means

In `npm run dev -- chat`: `/diff` shows this branch's changes scrollably, Ctrl+T
shows the full transcript, `/model` switches the active model and the footer updates.
Commit only the files you touched (conventional commit); do not push.
