# Tanya Integration Contract

Tanya exposes a CLI contract for automation consumers. Integrations should invoke
the generic JSONL stream instead of depending on product-specific event modes.

## Invocation

```bash
tanya run --json --cwd <path> "task"
tanya run --json --cwd <path> --prompt-file <prompt.md>
```

The removed `--cosmo` mode is not part of this contract.

## Stream Format

`--json` writes one JSON object per line to stdout. Each object has a `type`
field and may include `subRunId` when the event came from a child run.
Consumers must ignore unknown fields and should treat unknown event types as
forward-compatible additions.

| Event type | Fields |
| --- | --- |
| `status` | `message` |
| `message_start` | `elapsedMs?`, `headingStartedAt?` |
| `message_delta` | `text` |
| `message_end` | none |
| `reasoning_chunk` | `content`, `provider`, `model`, `runId`, `turn?`, `tokens?` |
| `reasoning_truncated` | `provider`, `model`, `usedTokens`, `capTokens`, `stepType` |
| `tool_call` | `id`, `tool`, `input` |
| `tool_progress` | `toolCallId`, `chunk`, `timestamp`, `stream` |
| `tool_cancel_requested` | `toolCallId`, `tool?`, `timestamp` |
| `tool_cancelled` | `toolCallId`, `tool?`, `timestamp`, `partialOutput?` |
| `permission_request` | `id`, `tool`, `input`, `matchedRule?`, `projectedCostUsd?`, `projectedTokens?` |
| `permission_decision` | `id`, `decision`, `source`, `persistAs?`, `matchedRule?`, `projectedCostUsd?`, `projectedTokens?`, `thresholdUsd?`, `thresholdTokens?` |
| `tool_result` | `id`, `tool`, `ok`, `summary`, `output?`, `error?`, `reason?`, `modelView?`, `verifierView?` |
| `tool_call_parse_warning` | `reason`, `provider?`, `turn?`, `attempt?`, `toolCallId?`, `tool?` |
| `schema_flatten_warning` | `reason`, `path`, `provider?`, `tool?` |
| `provider_throttle` | `provider`, `attempt`, `waitMs` |
| `model_routed` | `stepType`, `provider`, `model`, `reason`, `cacheImpact?` |
| `escalation_event` | `from`, `to`, `reason`, `stepType` |
| `compact_event` | `compactType`, `removedTokens`, `summaryTokens?`, `aggression?` |
| `prompt_budget_exceeded` | `droppedSections`, `totalTokens`, `cap` |
| `subtask_started` | `subRunId`, `parentRunId`, `prompt`, `workspace` |
| `subtask_completed` | `subRunId`, `parentRunId`, `verdict`, `summary`, `tokensUsed` |
| `command_invoked` | `name`, `args`, `runId?` |
| `subtask_start` | `subtask_id`, `title`, `files` |
| `subtask_done` | `subtask_id`, `files_changed`, `summary`, `ok` |
| `final` | `message`, `suppressHumanMessage?`, `files?`, `manifest?`, `metrics?` (`costUsd` is the actual run cost in USD, or `0` when pricing is unknown) |
| `error` | `message`, `detail?` |

`stepType` is one of `planning`, `tool_call`, `synthesis`, `verification`,
`reasoning`, or `unknown`.

## Final Verdict

Coding runs end with a final report verdict line:

```text
TANYA RESULT: PASSED
TANYA RESULT: FAIL
```

Consumers that inspect human final reports should match `TANYA RESULT: PASSED|FAIL`.

## Serve Mode

`tanya serve --stdio [--cwd <path>] [--resume <sessionId>]` starts one long-lived
chat session process and speaks bidirectional JSONL over stdin/stdout. It is meant
for GUI clients such as the macOS app. It does not open ports, authenticate, or
serve multiple sessions.

Stdout is JSONL only. Diagnostics and logs go to stderr. Outbound events reuse the
same event vocabulary as `tanya run --json`, plus these session events:

| Event type | Fields |
| --- | --- |
| `session_replay` | `messages: [{role, content, timestampMs}]` when resuming |
| `session_ready` | `sessionId`, `cwd`, `provider`, `model`, `protocolVersion: 1` |
| `turn_complete` | `elapsedMs`, optional `promptTokens`, `completionTokens`, `costUsd` |
| `commands` | `commands: [{name, description, category}]` — reply to `list_commands` |

Inbound messages are one JSON object per line on stdin:

| Message type | Fields |
| --- | --- |
| `user_message` | `text` — starts one agent turn with session history |
| `permission_answer` | `id`, `decision: "allow" \| "deny"`, optional `persistAs: "always" \| "never"` |
| `interrupt` | aborts the active turn |
| `command` | `text` — slash command such as `/clear`, `/cost`, `/verify`, `/memory` |
| `list_commands` | request the available slash commands; replied to with a `commands` event |
| `shutdown` | materializes the session and exits 0 |

If a `user_message` arrives while a turn is running, Tanya emits an `error` event
with `code: "busy"`; clients should queue on their side. Permission requests are
not auto-decided in serve mode. Tanya emits the normal `permission_request` event
and waits for a matching `permission_answer`. Unknown or stale permission ids,
malformed JSON lines, and invalid inbound shapes produce `error` events and keep
the session alive.

EOF on stdin and SIGTERM are treated like `shutdown`.

Forward compatibility: clients must ignore unknown event types and unknown fields.
Clients should check `protocolVersion` on `session_ready` and support version `1`.

## Listing Sessions

`tanya sessions list --json [--cwd <path>] [--all] [--global]` prints a single JSON
array of session summaries for a project — the machine-readable companion to the
human table. GUI clients use it to populate a session picker without parsing the
serve stream. Each element:

```json
{
  "id": "20260517-214851-abc123",
  "label": "Add a /search endpoint to the notes API",
  "cwd": "/path/to/project",
  "provider": "deepseek",
  "model": "deepseek-chat",
  "createdAt": "2026-05-17T21:48:51.234Z",
  "lastUpdatedAt": "2026-05-17T21:57:00.000Z",
  "turnCount": 12,
  "costUsd": 0.0342,
  "scope": "project"
}
```

`costUsd` is `0` when pricing for the provider/model is unknown. Ordering is
most-recently-updated first. `--cwd` scopes to a project's sessions (plus global);
`--global` restricts to global sessions; `--all` disables the default result cap.
Resume a listed session with `tanya serve --stdio --resume <id>`; delete one with
`tanya sessions rm <id>`. Consumers must ignore unknown fields.

## Setup Introspection

Two machine-readable helpers back the GUI's onboarding and settings.

`tanya doctor --json [--cwd <path>]` prints `{ cwd, checks, summary }`, where each
check is `{ name, status: "ok" | "warn" | "fail", detail }` and `summary` is
`{ ok, warn, fail }`. It never throws on a missing key — a broken provider config
becomes a `fail` check (`provider.config`). Exit code is non-zero when any check
fails.

`tanya providers list --json` prints `{ providers: [{ id, defaultBaseUrl,
defaultModel, requiresKey, apiKeyEnv }] }`. `requiresKey` is `false` for local
providers (e.g. `ollama`); `apiKeyEnv` is the environment variable the caller
should set for that provider's key (`DEEPSEEK_API_KEY` for deepseek, otherwise
`TANYA_API_KEY`). A GUI injects those into the `tanya serve --stdio` child
environment along with `TANYA_PROVIDER` and, optionally, `TANYA_BASE_URL` /
`TANYA_MODEL`.
