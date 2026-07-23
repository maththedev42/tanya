# Task: Codex-style composer core — bracketed paste + multi-line editing + cursor

You are working in the Tanya repo (`<repo-root>`),
a TypeScript ESM CLI (Node ≥20) with an Ink 5 + React 18 TUI. Work on a new branch
`feat/tui-01-composer`.

## Problem

`src/ui/ink/Input.tsx` is a naive single-line composer:

- Its `useInput` handler submits at the **first `\r`/`\n` found in an input chunk and
  discards the rest of the chunk** — pasting a multi-line prompt submits line 1 and
  silently loses everything else. This breaks the primary workflow: pasting large
  coding prompts authored by another AI.
- Backspace only deletes at the end of the buffer; there is no cursor movement at all.
- There is no bracketed-paste handling anywhere in the repo.

## Deliverable

Rewrite the composer so that:

1. **Bracketed paste works.** Enable bracketed paste mode on mount (`\x1b[?2004h` to
   stdout) and disable it on unmount/exit (`\x1b[?2004l`, also on process exit so the
   user's terminal isn't left dirty). Parse `\x1b[200~ … \x1b[201~` frames; paste
   content — including newlines — is **inserted at the cursor**, never submitted.
   Investigate how Ink 5.2.1 delivers stdin to `useInput`: paste frames may arrive
   split across chunks, so buffer partial start/end markers. If `useInput` mangles or
   splits sequences, attach a raw `data` listener via `useStdin()` for paste framing
   and keep `useInput` for ordinary keys — your call, but the paste path must be
   loss-proof for pastes of at least 100 KB.
2. **Multi-line buffer.** The composer holds `string` with `\n`s and renders as a
   growing box (cap the visible height at ~10 rows, scrolling the view to keep the
   cursor visible). Enter submits. **Ctrl+J inserts a newline**; a trailing `\` +
   Enter also inserts a newline (strip the `\`). Keep `/exit` and `/quit` submit-time
   handling as-is.
3. **Cursor editing.** Maintain a cursor index into the buffer and render it (inverse
   glyph, like today's block). Support: ←/→; ↑/↓ move across lines within a
   multi-line buffer (when the buffer is single-line, ↑/↓ are no-ops — a later
   package will bind them to history); Ctrl+A/Home and Ctrl+E/End (line start/end);
   Meta+←/→ or Meta+b/f (word jump); backspace/delete-backward at cursor;
   Ctrl+D deletes forward **only when the buffer is non-empty** (empty buffer keeps
   today's exit behavior); Ctrl+K (kill to end of line), Ctrl+U (kill whole line),
   Ctrl+W (delete word back). Ctrl+C keeps today's exit/cancel behavior.
4. **Extract a pure editing core.** Put the buffer+cursor state machine in a new
   `src/ui/ink/composer/buffer.ts` (pure functions: `insert`, `deleteBack`,
   `moveCursor`, `killLine`, …) and the key/paste decoding in
   `src/ui/ink/composer/keys.ts`, with `Input.tsx` as the thin Ink wrapper. Packages
   02–05 will build on these modules — export them cleanly.

## Constraints

- Preserve the perf contract: `Input` stays `React.memo`'d and App's stable
  `onSubmit`/`onExit` callback refs keep working unchanged (see the comment at the
  bottom of `Input.tsx` and in `App.tsx`). App's public props for `Input` may gain
  fields but must not force History/ActivityPanel re-renders per keystroke.
- Don't change submit semantics seen by `App.tsx` (`onSubmit(value: string)`).
- Don't touch `dist/`, don't reformat unrelated files.

## Tests (vitest + ink-testing-library, see `src/ui/ink/__tests__/`)

- Pure-core unit tests for `buffer.ts` (insert/delete/word-jump/kill at edge cases).
- Component tests driving `stdin.write(...)`: (a) paste frame with 5 lines →
  nothing submitted, buffer shows 5 lines, Enter submits all 5 joined by `\n`;
  (b) paste frame split across two writes; (c) Ctrl+J newline; (d) cursor-middle
  insertion; (e) Ctrl+D on empty buffer still exits.
- `npm run typecheck && npm test` must pass.

## Done means

Pasting this very file into `npm run dev -- chat` shows every line in the composer
and one Enter submits the whole document as a single user message. Commit only the
files you touched (conventional commit); do not push.
