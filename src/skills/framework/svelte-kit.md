---
slug: framework/svelte-kit
title: SvelteKit
loadWhen:
  - kind: workspace.has
    path: svelte.config.js
  - kind: workspace.has
    path: svelte.config.ts
  - kind: workspace.packageJson
    dep: "@sveltejs/kit"
  - kind: hint.framework
    value: svelte-kit
sizeTarget: 700
priority: 4
---
# SvelteKit
## When this applies
Use this for SvelteKit workspaces detected through `svelte.config.js`/`.ts`, an `@sveltejs/kit` dependency, or a SvelteKit framework hint.

## Core rules
- Routing is file-based under `src/routes`: `+page.svelte` (UI), `+page.ts` (universal load), `+page.server.ts` (server-only load + form actions), `+layout.*` for shared shells.
- Load data in `load` functions and consume it via `PageData`; do not `onMount`+`fetch` for data that can load during SSR.
- Mutate with form actions in `+page.server.ts` and progressively enhance the form with `use:enhance`; validate input server-side before use.
- Keep secrets server-only: import them from `$env/static/private` or `$env/dynamic/private`. Public values need the `PUBLIC_` prefix via `$env/static/public`. Never import a private env module from a universal (`+page.ts`) or client file.
- Handle auth/session in `src/hooks.server.ts` (the `handle` hook) and expose per-request state through `event.locals` (typed in `src/app.d.ts`).
- Inside `load`, use the provided `fetch` (`event.fetch`) so relative API calls and SSR cookie/credential forwarding work.
- Use `error()` and `redirect()` from `@sveltejs/kit`; add `+error.svelte` where a route needs a recovery UI.
- Pick the adapter that matches the deploy target (`adapter-auto`/`-node`/`-vercel`/`-static`) in `svelte.config.js`.
- On Svelte 5, prefer runes (`$state`, `$derived`, `$props`, `$effect`) over legacy reactive `let`/`$:`.

## Common pitfalls
- CLIENT-SECRET-LEAK: importing `$env/static/private` (or `$env/dynamic/private`) from a universal/client module ships the secret to the browser.
- ONMOUNT-FETCH: fetching in `onMount` for data that should have come from a `load` function (breaks SSR and adds a client waterfall).
- LOAD-WATERFALL: sequential `await`s in a `load` that could run in parallel with `Promise.all`.
- MISSING-ENHANCE: a form action without `use:enhance` loses progressive enhancement and full-page-reloads.
- BARE-FETCH-IN-LOAD: using global `fetch` instead of the `load` event's `fetch`, dropping SSR cookies.

## House style
Reference apps keep server logic in `+page.server.ts`/`+server.ts`, share state via `locals` + `app.d.ts`, guard secrets behind `$env/*/private`, and verify with `svelte-check` plus Vitest.

## Verification commands
- `npm run check` (or `npx svelte-check --tsconfig ./tsconfig.json`)
- `npm run build`
- `npx vitest run`
- `rg -n "onMount\\(.*fetch|\\$env/static/private|\\$env/dynamic/private" src/routes src/lib`

## Canonical sources
- svelte.config.js
- src/routes
- src/hooks.server.ts
- src/app.d.ts
