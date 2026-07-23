# Task: Prompt-file ergonomics — stdin, /file command, chat --prompt-file

You are working in the Tanya repo (`<repo-root>`),
a TypeScript ESM CLI (Node ≥20). Branch: `feat/tui-07-prompt-file`. This package is
independent of the TUI composer work and can land first. Purpose: make the
"another AI writes a big coding prompt → Tanya executes it" loop first-class.

## Context (read first)

- `src/cli.ts` — `readPrompt(args)` resolves the prompt for `run`/`ask`: it honors
  `--prompt-file <path>` (added to `cliOptionDefinitions` around line 110) and
  otherwise joins positional args. Commands are wired with commander via
  `configureCliCommand`; help text lives in the big template string in the same file
  (see the `tanya run --prompt-file` examples already there).
- Interactive slash commands: built-ins in `src/commands/builtin/`, registered via
  `src/commands/registry.ts`, dispatched by `dispatchInteractiveCommand` in
  `src/agent/chat.ts`. Both the readline REPL and the Ink UI (`src/ui/ink/App.tsx`)
  go through this dispatcher — a new built-in automatically works in both.
- Chat entry: `runInkChat` (`src/ui/ink/runInkChat.tsx`) mounted from the chat
  command path in `src/cli.ts`.

## Deliverables

1. **Stdin prompts.** `tanya run -` and `tanya ask -` (positional `-`), plus
   `--prompt-file -`, read the entire prompt from stdin. Extend `readPrompt` (make
   it async or add an async wrapper — follow existing call sites). Guard: if `-` is
   given but stdin is a TTY, fail fast with a clear usage error instead of hanging.
   This enables `pbpaste | tanya run -` and heredocs.
2. **`/file <path>` built-in slash command** (alias `/prompt`). Reads the file
   (relative to the chat cwd or absolute, `~` expanded), posts a system line
   `Loaded <path> — N lines`, and submits the content as the user message for a
   normal agent turn. Errors (missing/unreadable/empty, >1 MB) produce a friendly
   message, never a crash. Implement it so the submission path is identical to a
   typed message (history, sessions, stats all behave normally) — study how
   `dispatchInteractiveCommand` consumers trigger turns; if commands currently can't
   trigger an agent turn, add the smallest hook (e.g. a `submitPrompt` callback in
   the dispatcher options, wired in both REPL and Ink App).
3. **`tanya chat --prompt-file <path>`.** Starts interactive chat and auto-submits
   the file content as the first message (banner line first: `Prompt loaded from
   <path>`). Reuse the same loading/validation as `/file`.
4. **Docs.** Update the help text in `src/cli.ts`, `README.md` usage section, and
   add a short "Feeding prompts from files/clipboard" subsection to
   `docs/integration-contract.md` or the most fitting doc — include the
   `pbpaste | tanya run -` and `/file docs/prompts/foo.md` recipes.

## Constraints

- Do not break existing consumers: `tanya run --json --prompt-file …` is used by
  CosmoChat/AppCreator — its behavior and output contract must be unchanged.
- Keep `readPrompt` behavior for plain positional prompts byte-identical.
- No new dependencies.

## Tests (vitest; CLI tests live under `src/cli/__tests__/` and commands under
`src/commands/__tests__/`)

- `readPrompt`/stdin: `-` reads stdin (stub stream), TTY guard errors, precedence
  when both positional and `--prompt-file` are given (match current precedence).
- `/file`: happy path submits content as a user turn; missing file → friendly error;
  size cap enforced.
- `chat --prompt-file`: unit-test the arg plumbing (no need to mount the full TUI).
- `npm run typecheck && npm test` must pass.

## Done means

`pbpaste | tanya run -` executes a copied prompt; in chat, `/file docs/prompts/codex-tui/00-PLAN.md`
runs a turn on that file's content; `tanya chat --prompt-file x.md` opens chat with
the prompt already submitted. Commit only the files you touched (conventional
commit); do not push.
