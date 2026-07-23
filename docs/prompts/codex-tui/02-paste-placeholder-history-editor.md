# Task: Composer ergonomics — large-paste placeholder, input history, external editor

You are working in the Tanya repo (`<repo-root>`),
a TypeScript ESM CLI (Node ≥20) with an Ink 5 + React 18 TUI. Branch:
`feat/tui-02-composer-ergonomics`. **Prerequisite:** package 01 has landed — the
composer is multi-line with bracketed paste, built on `src/ui/ink/composer/buffer.ts`
and `src/ui/ink/composer/keys.ts`, wrapped by `src/ui/ink/Input.tsx`. Read those
first and extend them; do not fork a second composer.

## Deliverables

1. **Large-paste placeholder (Codex-style).** When a single paste exceeds ~15 lines
   or ~1,500 chars, don't inline it in the visible buffer: store the payload aside
   and render a dim atomic token like `[pasted ~142 lines]` at the insertion point.
   The token behaves as one character for cursor movement and backspace (deleting it
   discards that payload). On submit, expand every placeholder back into its full
   text. Multiple pastes in one message must work. The transcript (`History`) shows
   the expanded message but clamped as it already does today.
2. **Input history.** ↑ at the first line / ↓ at the last line of the buffer walks
   submission history (most recent first), like a shell; editing a recalled entry
   then navigating keeps your edit in a scratch slot. Persist history to
   `.tanya/input-history.jsonl` in the project cwd (one JSON string per line, append
   on submit, dedupe consecutive duplicates, load last 200 on boot, cap file at 1,000
   entries on write). Slash commands are included in history. Respect the existing
   `.tanya/` dot-dir conventions (see `src/init/migrateDotDir.ts` usage in `App.tsx`).
3. **External editor.** Ctrl+X opens `$VISUAL`/`$EDITOR` (fallback `vi`) on a temp
   file seeded with the current buffer (placeholders expanded); on editor exit, the
   composer is replaced with the file content. You must suspend Ink cleanly: disable
   raw mode / pause rendering, spawn the editor with `stdio: "inherit"`, then restore
   raw mode, re-enable bracketed paste (`\x1b[?2004h`), and force a repaint.
   If spawning fails, show a system message and leave the buffer untouched.

## Constraints

- Preserve the `React.memo` + stable-refs perf pattern (`Input.tsx` bottom comment).
- History file I/O must be lazy/async so boot time doesn't regress
  (`boot_progress`/`boot_complete` flow in `App.tsx`).
- No new runtime dependencies without strong justification.

## Tests (vitest + ink-testing-library)

- Placeholder: oversized paste renders token, submit expands it, backspace over the
  token removes the payload; two pastes in one message.
- History: submit three messages, ↑↑ recalls in order, ↓ returns, scratch edit
  preserved; persistence round-trip via a temp cwd.
- Editor: unit-test the suspend/restore sequencing with an injected spawn stub
  (don't launch a real editor in CI).
- `npm run typecheck && npm test` must pass.

## Done means

Pasting a 300-line prompt shows a single `[pasted ~300 lines]` token, Enter sends
the full text; ↑ recalls it after send; Ctrl+X round-trips through `$EDITOR`.
Commit only the files you touched (conventional commit); do not push.
