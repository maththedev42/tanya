# Kimi (Moonshot AI) provider — CLI + mac app plan

Status: BUILT 2026-07-18 (`9487e65` = Parts 1–4 + registry/env/pricing/balance/
Swift; follow-up commit = the Part 6 unit tests + this note). All VERIFY-LIVE
items below remain UNPROBED — no Moonshot key was available at build time; they
are recorded as ASSUMPTIONS in the beta.17 CHANGELOG entry. Part 5 (router
example) is documented here only, deliberately not shipped as defaults.
Scope: the tanya repo only (CLI provider stack + mac app settings). Everything
below was verified against the current code (paths/lines cited) and the current
Moonshot platform docs (July 2026) — API facts that could NOT be verified from
docs are marked **VERIFY-LIVE** and must be probed during the build, not assumed.

## Why this is small

Tanya's provider stack is a single `OpenAiCompatibleProvider` shaped by
per-provider adapters (`src/providers/adapters/*.ts`, registered in
`adapters/index.ts`). Moonshot's API is OpenAI-compatible at
`https://api.moonshot.ai/v1` with `Authorization: Bearer <key>`. The mac app
does NOT hardcode providers — it runs `tanya providers list --json`
(`SetupServices.swift:78`) and renders whatever comes back, storing the key in
the Keychain per provider id. So the core deliverable is **one new adapter file
+ registry entry**; the rest is pricing/balance/env polish and one small Swift
generalization.

Note on the "CLI-auth only, never API keys" rule: that directive is scoped to
**CosmoChat** agent providers (`cosmochat/api/pkg`). Tanya's provider stack is
deliberately direct-API (DeepSeek precedent: `DEEPSEEK_API_KEY`, keychain in the
app). Kimi via `KIMI_API_KEY` follows the existing tanya model and does not
violate that rule. (Wiring the separate `kimi-cli` as a CosmoChat coding-step
provider would be a different work item in cosmohq-v3 — explicit NON-GOAL here.)

## Current Moonshot facts (verified July 2026)

- Base URL: `https://api.moonshot.ai/v1` (there is also a `.cn` platform; default
  to `.ai`, overridable via base-url settings that already exist).
- Auth: `Authorization: Bearer` key from platform console. Official env
  convention `MOONSHOT_API_KEY`.
- Models (current; legacy K2 family was EOL'd 2026-05-25, `moonshot-v1-*` and
  `kimi-k2.5` closed to new users after the K3 launch):
  - `kimi-k3` — flagship, **1M context**, vision, thinking (`reasoning_effort:
    "max"` is the only accepted value), `tool_choice` supports
    `auto|none|required`.
  - `kimi-k2.7-code` — coding-focused, 256k, thinking ALWAYS on (accepts only
    `{"type":"enabled","keep":"all"}`), `tool_choice` `auto|none` only —
    **`required` returns an error**.
  - `kimi-k2.7-code-highspeed` — same, ~180 tok/s output tier.
  - `kimi-k2.6` — 256k, thinking `{"type":"enabled"|"disabled"}`, `tool_choice`
    `auto|none` only.
- **Sampling params are FIXED server-side** on k3/k2.7/k2.6: temperature (1.0;
  k2.6 non-thinking 0.6) and top_p (0.95) "cannot be modified". Tanya ALWAYS
  sends `temperature` (default 0) and `top_p` (default 0.2)
  (`openAiCompatible.ts:147-148,171-172`) → the adapter MUST strip both.
  **VERIFY-LIVE** whether sending them errors or is silently ignored; strip
  regardless.
- Reasoning: assistant messages carry `reasoning_content`; docs say "pass the
  complete assistant message returned by the API back to `messages` as-is" →
  `roundTripReasoning: true`. Tanya's machinery already handles this generically
  (`messagesForAdapter`, `openAiCompatible.ts:93-109`) — the flag is enough.
- Balance: `GET {base}/users/me/balance` — same idea as DeepSeek's
  `/user/balance` that `deepseekBalance.ts` + `tanya cost` already surface.
  Response shape `{code, data:{available_balance, voucher_balance,
  cash_balance}, status}` — **VERIFY-LIVE** exact fields.
- Pricing per 1M tokens (from Moonshot newsletter/aggregators, July 2026):
  `kimi-k2.7-code` $0.72 in / $3.50 out; `kimi-k2.6` $0.95 / $4.00, cache-hit
  $0.16; `kimi-k2.5` $0.60 / $3.00, cache-hit $0.10. `kimi-k3` and
  `k2.7-code-highspeed` pricing **VERIFY-AT-BUILD** from
  https://platform.kimi.ai/docs/pricing/k3.md (fetch failed to surface numbers).
- Cache-hit usage field: DeepSeek reports `prompt_cache_hit_tokens`; Moonshot
  likely uses OpenAI-style `usage.prompt_tokens_details.cached_tokens` —
  **VERIFY-LIVE** and wire into `estimateRunCost` if present (runLogs.ts keys on
  the DeepSeek field today).

## Part 1 — CLI adapter (the core)

New file `src/providers/adapters/kimi.ts`:

```ts
import type { ProviderAdapter } from "./types";
import { withoutUnsupportedToolChoice } from "./types";

export const kimiAdapter: ProviderAdapter = {
  id: "kimi",
  matchBaseUrl: /api\.moonshot\.(ai|cn)|\.kimi\./i,
  defaultBaseUrl: "https://api.moonshot.ai/v1",
  defaultModel: "kimi-k2.7-code",
  capabilities: {
    toolChoiceRequired: false,   // k2.6/k2.7 ERROR on "required" (k3 allows it — keep conservative)
    parallelToolCalls: false,    // VERIFY-LIVE; conservative default
    jsonMode: true,              // VERIFY-LIVE response_format json_object
    vision: true,                // k2.x/k3 are multimodal
    reasoning: true,
    roundTripReasoning: true,    // docs: return assistant msg incl. reasoning_content as-is
    flattenSchemas: false,       // VERIFY-LIVE with a nested-schema tool call
    contextWindow: 256_000,      // k2.x; k3's 1M comes via route maxInputTokens
  },
  preRequest: (req) => {
    // temperature/top_p are FIXED server-side on k3/k2.7/k2.6 — never send them.
    const { temperature: _t, top_p: _p, ...rest } = withoutUnsupportedToolChoice(req);
    return rest;
  },
};
```

- Default model choice: `kimi-k2.7-code` — coding-focused (tanya IS a coding
  agent), cheapest current tier, ~30% fewer reasoning tokens per agentic loop
  per Moonshot. `kimi-k3` is the escalation/long-context pick, not the default.
- `withoutUnsupportedToolChoice` already exists (`adapters/types.ts`) and is the
  same treatment qwen gets. Do NOT special-case k3's `required` support in v1 —
  `toolChoiceRequired:false` keeps one behavior across models.
- Thinking control: none in v1. k2.7-code thinks always (nothing to send); the
  `thinking`/`reasoning_effort` extensions are a follow-up if we want a
  "fast/no-think" k2.6 route. Keep v1 protocol-clean.

Register in `src/providers/adapters/index.ts`:
- add `kimiAdapter` to `providerAdapters` (before `openAiAdapter`, which is the
  fallback and must stay last-ish; order otherwise irrelevant).
- aliases: `["moonshot", "kimi"]`, `["moonshotai", "kimi"]`, and model-style
  aliases are NOT needed (resolution is by provider id / base URL).

## Part 2 — config, env, providers list

1. `src/cli.ts:663-681` (`listProviders`): `apiKeyEnv` is a hardcoded ternary
   (`deepseek ? DEEPSEEK_API_KEY : TANYA_API_KEY`). Add an optional
   `apiKeyEnv?: string` to `ProviderAdapter` (adapters/types.ts), set
   `"KIMI_API_KEY"` on the kimi adapter and `"DEEPSEEK_API_KEY"` on deepseek,
   and emit `adapter.apiKeyEnv ?? "TANYA_API_KEY"`. This is what makes the mac
   app (Part 4) able to inject per-provider vars generically.
2. `src/config/env.ts:37-49`: mirror the deepseek special case for kimi so a
   user-level `KIMI_API_KEY` / `KIMI_BASE_URL` works when
   `TANYA_PROVIDER=kimi` (today only `TANYA_API_KEY` would be read). Accept
   `MOONSHOT_API_KEY` as a fallback alias (`KIMI_API_KEY || MOONSHOT_API_KEY ||
   TANYA_API_KEY`) — people copy it from Moonshot docs.
3. `createProviderForRoute` (`factory.ts`) already derives `KIMI_API_KEY` /
   `KIMI_BASE_URL` from the provider id — router targets need zero changes.

## Part 3 — pricing, cache-hit, balance

1. `src/memory/runLogs.ts:60-65`: the price table is DeepSeek-only and
   `resolvePricing` gates on `provider === "deepseek"` (line 78). Extend to a
   per-provider map:
   ```ts
   const pricingByProviderModel: Record<string, Record<string, Pricing>> = {
     deepseek: deepSeekPricingByModel,
     kimi: {
       "kimi-k2.7-code": { inputPerMillion: 0.72, outputPerMillion: 3.5 },
       "kimi-k2.6": { inputPerMillion: 0.95, outputPerMillion: 4.0, cacheHitPerMillion: 0.16 },
       "kimi-k2.5": { inputPerMillion: 0.6, outputPerMillion: 3.0, cacheHitPerMillion: 0.1 },
       // kimi-k3 + k2.7-code-highspeed: fill from pricing page at build time.
     },
   };
   ```
   Keep the `TANYA_PRICE_*` env overrides working unchanged. Add cache-hit rate
   for k2.7-code once verified (the newsletter lists cache pricing for k2.5/k2.6
   and legacy only).
2. Cache-hit token field: find where `prompt_cache_hit_tokens` is read
   (runLogs/openAiCompatible usage plumbing) and also accept
   `prompt_tokens_details.cached_tokens` (OpenAI/Moonshot style), normalized to
   the same field. **VERIFY-LIVE** with a real 2-turn call.
3. New `src/providers/kimiBalance.ts` mirroring `deepseekBalance.ts`: GET
   `{base}/users/me/balance`, parse `{data:{available_balance,...}}`, short
   timeout, null on anything unexpected. Surface it exactly where DeepSeek's is
   surfaced: `tanya cost` (`commands/builtin/cost.ts:82` gates on provider) and
   `testProvider` (`cli.ts` — the `config.provider === "deepseek"` balance
   block). Consider folding both into one `fetchProviderBalance(provider, ...)`
   dispatcher so the third provider with a balance endpoint doesn't copy-paste.

## Part 4 — mac app

1. **Provider picker: free.** `providers list --json` now includes kimi →
   Settings picker, Keychain storage (`account: "kimi"`), `providers test
   --provider kimi` all work with no Swift changes.
2. **Env injection: one small generalization.**
   `ProviderSettings.environmentVariables` (`ProviderSettings.swift:120-137`)
   injects `TANYA_API_KEY` + a hardcoded `DEEPSEEK_API_KEY` special case. The
   descriptor already carries `apiKeyEnv` — use it:
   ```swift
   if !key.isEmpty {
     vars["TANYA_API_KEY"] = key
     if let envName = activeProvider?.apiKeyEnv, envName != "TANYA_API_KEY" {
       vars[envName] = key
     }
   }
   ```
   (keeps deepseek working via its descriptor's `DEEPSEEK_API_KEY`, gives kimi
   `KIMI_API_KEY`, deletes the special case). Update `SettingsTests` /
   `OnboardingModelTests` fixtures that assert the deepseek special case, if any.
3. **Copy:** Settings shows base-url/model override fields already — no new UI.
   If onboarding hardcodes a provider name list anywhere (check
   `OnboardingModelTests.swift` fixtures), add kimi; otherwise nothing.
4. App relaunch required after rebuilding the CLI (`npm run build`) — the
   provider list is fetched from the linked CLI. Follow the quit + kill-serve +
   reopen recipe.

## Part 5 — router (opt-in only, no default changes)

Do NOT touch `BUILT_IN_ROUTE_DEFAULTS` / cascade. Document (README or
CHANGELOG) an example `~/.tanya/routes.json`:

```json
{
  "version": 1,
  "routes": [
    { "match": "tool_call", "provider": "kimi", "model": "kimi-k2.7-code" },
    { "match": "reasoning", "provider": "kimi", "model": "kimi-k3" }
  ],
  "defaults": { "provider": "kimi", "model": "kimi-k2.7-code" },
  "cascade": [
    { "provider": "kimi", "model": "kimi-k2.7-code", "maxInputTokens": 256000 },
    { "provider": "kimi", "model": "kimi-k3", "maxInputTokens": 1000000 }
  ]
}
```

## Part 6 — tests

Unit (no network):
- `adapters/__tests__`: kimi registered; `resolveProviderAdapter({provider:
  "moonshot"})` → kimi; `matchBaseUrl` catches `https://api.moonshot.ai/v1` and
  `.cn`; `preRequest` strips `temperature`, `top_p`, and `tool_choice:
  "required"` while preserving tools/messages.
- `messagesForAdapter` round-trips `reasoning_content` for kimi (flag-driven —
  probably already covered generically; add one kimi-tagged case).
- `resolvePricing("kimi", "kimi-k2.7-code")` returns the table entry; env
  override still wins.
- `kimiBalance` parser: happy shape, error shape → null, timeout → null.
- `listProviders` JSON contains `{id:"kimi", apiKeyEnv:"KIMI_API_KEY",
  requiresKey:true, defaultModel:"kimi-k2.7-code"}`.

Live (needs a real key, `TANYA_RUN_LIVE_PROVIDER_TESTS=1`):
- `tanya providers test --provider kimi` → streaming PASS.
- One agentic run with a tool call (settles: parallel tool calls?, schema
  flattening needed?, json mode?, cached-tokens field name, whether stripped
  sampling params were actually required). Update the adapter's capability flags
  + this plan's VERIFY-LIVE items with what's observed — per the hardcoded-
  external-fact rule, record an `ASSUMPTION:` for anything left unprobed.

## Verify checklist (build session must clear all)

1. `npx vitest run` green (except the known `cliTestApp` parallel-load flake).
2. `tanya providers list` shows kimi; `--json` parses in the app
   (`ProviderDescriptor` decode — field names must match exactly).
3. Live probe with a real key (user creates one at platform.moonshot.ai) — or an
   explicit ASSUMPTION list if the key isn't available at build time.
4. CHANGELOG entry + version bump (next beta), `npm run build`, BUILD_ID check.
5. Path-limited commits (src / tests / release), nothing pushed.
6. Mac app: quit + kill stale serve + relaunch; Settings → select Kimi, paste
   key, `providers test` from the app passes; one chat turn end-to-end.

## Explicit non-goals (v1)

- No `thinking` / `reasoning_effort` control surface (k2.7-code always thinks).
- No kimi entries in built-in router defaults/cascade.
- No kimi-cli / CosmoChat integration (different repo, different auth rule).
- No `.cn` endpoint auto-detection (base-url override covers it).
