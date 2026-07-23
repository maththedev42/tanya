# Task: Esc-to-interrupt, type-while-running queue, Esc-Esc recall

You are working in the Tanya repo (`<repo-root>`),
a TypeScript ESM CLI (Node ≥20) with an Ink 5 + React 18 TUI. Branch:
`feat/tui-05-interrupt-queue`. **Prerequisite:** package 01 (multi-line composer on
`src/ui/ink/composer/`) has landed.

## Context (read first)

- `src/ui/ink/App.tsx`: each turn runs `runAgent` with an `AbortController` held in
  `activeAbortController`; today the **only** way to abort is Ctrl+C via
  `handleExit`, and while a turn is pending the composer is disabled
  (`disabled={… state.pendingTurn !== null …}`).
- Focus routing: `PermissionPrompt` and `SessionPicker` capture input while open —
  the new key handling must not swallow their keys.
- `src/ui/ink/state.ts` holds the reducer; add actions there, keep it pure.

## Deliverables

1. **Esc interrupts.** While a turn is running (`pendingTurn !== null`) and no
   permission prompt/session picker is open, Esc aborts `activeAbortController`,
   emits a system message `Interrupted — partial work kept.`, and finalizes the turn
   state exactly like the existing error path does (spinner cleared, input
   re-enabled). Verify what `runAgent` does on abort (see how `App.tsx` catches
   turn errors) — an aborted run must not be double-reported as an error.
2. **Type-while-running queue.** The composer stays **enabled** during a run: typing
   is allowed, Enter enqueues the message instead of submitting. Render queued
   messages as dim `⧗ queued:` lines between ActivityPanel and Input (new reducer
   state `queued: string[]`). When the turn completes (success or error), auto-submit
   the queue in order, one turn at a time. Esc with a non-empty queue first clears
   the queue (system message `Cleared N queued message(s).`), a second Esc aborts the
   running turn. Slash commands typed mid-run are also queued (they dispatch when
   drained), except `/exit`//`/quit` which keep working immediately.
3. **Esc-Esc recall (backtrack-lite).** When idle with an empty composer, pressing
   Esc twice within ~500 ms loads the last submitted user message into the composer
   for editing (uses the composer buffer API from package 01; plays nice with
   package 02 history if present — recall does not append a duplicate history entry).

## Constraints

- Preserve the `React.memo` + stable-refs perf contract (`Input.tsx` bottom comment).
- Permission prompts must still be answerable while messages are queued; a queued
  message must never auto-answer or race a pending permission request.
- Ctrl+C behavior is unchanged (cancel run / deny permission / exit).

## Tests (vitest + ink-testing-library)

- Reducer tests: enqueue/drain/clear actions; interrupted turn finalizes state.
- Component tests with a stubbed provider/`runAgent` (see how `components.test.tsx`
  builds a fake `ChatProvider`): Esc during a pending turn calls abort exactly once;
  Enter mid-run renders a `⧗ queued:` line and drains after completion in order;
  Esc-Esc idle recall restores the last message.
- `npm run typecheck && npm test` must pass.

## Done means

In `npm run dev -- chat`: start a long task, type the next instruction while it
streams, watch it auto-send after the turn; Esc stops a runaway turn cleanly.
Commit only the files you touched (conventional commit); do not push.
