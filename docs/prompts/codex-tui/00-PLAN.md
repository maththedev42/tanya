# Codex-style TUI for Tanya — master plan

Goal: make `tanya` (interactive chat) feel like the OpenAI Codex CLI — a first-class
terminal composer you can paste large Claude-authored coding prompts into, with
command/file autocomplete, interrupt/queue ergonomics, and diff/transcript overlays.

Date: 2026-07-06. Repo: `<repo-root>`.

## Why now — the paste finding

The Ink composer (`src/ui/ink/Input.tsx`) submits on the **first `\r`/`\n` of any
input chunk and discards the rest of the chunk**. Pasting a multi-line prompt into
`tanya` chat therefore submits line 1 and silently drops the remainder. There is no
bracketed-paste handling anywhere in the TUI, no cursor movement (backspace only
deletes at the end), no input history.

Non-interactive ingestion already works: `tanya run --prompt-file <path>` and
`tanya ask --prompt-file <path>` (`readPrompt()` in `src/cli.ts`). That is today's
workaround for running Claude-authored prompts, and it is how AppCreator drives Tanya.

## Current TUI inventory (already built, keep working)

- `src/ui/ink/App.tsx` — orchestration; `useReducer` over `state.ts`; runs
  `runAgent` per turn; slash commands via `dispatchInteractiveCommand` (`src/agent/chat.ts`).
- `src/ui/ink/state.ts` — `InkState` + actions (`user_message`, `assistant_delta`,
  `turn_start/progress/complete/error`, `activity_*`, `permission_*`, `session_picker_*`, …).
- `src/ui/ink/Input.tsx` — the naive composer (rewrite target).
- `History.tsx` (Static transcript), `ActivityPanel.tsx`, `Footer.tsx`,
  `PermissionPrompt.tsx`, `SessionPicker.tsx`, `sinkAdapter.ts`, `runInkChat.tsx`.
- Perf contract: `Input` is `React.memo`'d with stable `onSubmit`/`onExit` refs from
  App (see comment in `App.tsx`). Every prompt must preserve this.
- Tests: vitest + `ink-testing-library` (`src/ui/ink/__tests__/`). Gate:
  `npm run typecheck && npm test`.

## Work packages (one prompt file each, copy-paste to any agent)

| # | Prompt | What it delivers | Depends on |
|---|--------|------------------|------------|
| 01 | `01-composer-paste-multiline.md` | Bracketed paste, multi-line buffer, full cursor editing. **The enabler.** | — |
| 02 | `02-paste-placeholder-history-editor.md` | Large-paste placeholder, ↑/↓ persisted input history, Ctrl+X `$EDITOR` | 01 |
| 03 | `03-slash-command-popup.md` | `/` fuzzy command menu with descriptions | 01 |
| 04 | `04-file-mentions.md` | `@` fuzzy file-path autocomplete | 01 |
| 05 | `05-esc-interrupt-and-queue.md` | Esc interrupts a running turn; type-while-running message queue; Esc-Esc recalls last message | 01 |
| 06 | `06-overlays-diff-transcript-model.md` | Scrollable overlay framework: `/diff`, Ctrl+T transcript, `/model` picker | — |
| 07 | `07-prompt-file-ergonomics.md` | `tanya run -` (stdin), REPL `/file <path>`, `chat --prompt-file` preload | — |

## Dispatch order

1. **07 first** — smallest, independent, and immediately unblocks the
   Claude-writes-prompt → Tanya-executes loop even before the TUI work lands.
2. **01 next** — everything composer-related builds on it.
3. Then **02, 03, 04, 05 in parallel** (all touch the composer but in separable
   modules if 01 lands the buffer/keymap abstraction it specifies).
4. **06 anytime in parallel** (doesn't touch the composer).

## Executor guidance

- 01 and 02 involve gnarly raw-terminal input handling → give to Codex or Claude Code.
- 03–07 are well-scoped → any agent, including Tanya itself (dogfood):
  `tanya run --prompt-file docs/prompts/codex-tui/07-prompt-file-ergonomics.md --cwd .`
- One prompt per fresh agent session, started in the repo root.

## Ground rules (embedded in every prompt)

- Branch per package: `feat/tui-<nn>-<slug>`; conventional commits; commit only the
  files you touched (no `git add -A`). Do not push without asking.
- `npm run typecheck && npm test` must pass; add tests for new behavior
  (ink-testing-library `stdin.write` drives key/paste sequences).
- Never edit `dist/`; never break the `React.memo` + stable-refs perf pattern;
  never regress the CosmoChat consumer surface (`tanya run --json`).
- Manual check: `npm run dev -- chat` in a scratch project (needs provider keys).

## Acceptance (whole initiative)

Paste this entire file into `tanya` chat → the composer shows all lines, Enter
submits the whole thing, `/` pops the command menu, `@` finds files, Esc interrupts,
Ctrl+T shows the transcript, and `tanya run - < prompt.md` works from a pipe.
