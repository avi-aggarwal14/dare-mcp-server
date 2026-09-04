# Working on this repo

Context for any agent picking this up.

## What this is

An MCP server that drives **trydare.com**'s private API so Seedance 2.5 (and Dare's other
video/image models) can be used from Claude Code and the Claude desktop app, billed to the
owner's existing Dare credit balance.

Dare publishes **no developer API**. Everything here was reverse-engineered from their
production JS bundles. That has two consequences worth holding onto:

1. Dare can change the contract at any time, without notice or a changelog.
2. When something breaks, the fix is to re-read their bundles, not to guess.

## Verification status

| Layer | Status |
| --- | --- |
| MCP handshake, tool schemas, annotations | verified (`npm run check` + `node scripts/smoke.mjs`) |
| Credit pricing arithmetic | verified against Dare's own estimator |
| Clerk token minting | endpoint confirmed live; full flow needs a real `__client` cookie |
| `generations.create` payload | derived from the client bundle, **not yet confirmed against the live server** |

The last row is the risk. If a real generation fails, that is the first place to look.

## How the contract was derived

Dare's frontend is a TanStack SPA. The bundles are served unminified-ish at
`https://trydare.com/assets/*.js` and are readable with `grep -a`:

```bash
curl -s https://trydare.com | grep -aoE '/assets/[A-Za-z0-9_.-]+\.js' | sort -u
```

The files that matter:

- `composer-view-*.js` — builds the `generations.create` payload. Look for the
  `mutateAsync({ spec, count, ... })` call, **not** the object built just above it: that one
  (`tool`, `kind`, `model`, `prompt`, `pendingPrompt`, `rowCount`) feeds PostHog analytics and
  the optimistic library placeholder and is never sent. Getting this wrong was the original bug.
- `workspace-catalog-*.js` — per-model constraints: durations, aspect ratios, qualities,
  reference limits. Mirrored in `src/catalog.ts`.
- `src-1-*.js` — the credit cost calculator. Also mirrored in `src/catalog.ts`.
- `orpc-*.js` — the transport: `POST {VITE_SERVER_URL}/rpc` with
  `Authorization: Bearer <clerk session jwt>`.

## Architecture

```
src/config.ts    env parsing
src/auth.ts      Clerk session-token minting from the long-lived __client cookie
src/rpc.ts       oRPC transport ({json, meta} envelope), retry policy, error mapping
src/catalog.ts   model constraints + credit pricing (pure, no I/O)
src/dare.ts      workflows: create, poll, upload, cost guard
src/server.ts    MCP tool definitions
src/stdio.ts     entrypoint for Claude Code / Claude desktop
src/http.ts      optional remote entrypoint
```

## Invariants — do not regress these

- **Never retry `generations.create` on an auth failure.** Dare has no idempotency key, so a
  replay bills twice. `REPLAYABLE` in `src/rpc.ts` is an allowlist of read-only procedures.
- **Always return `generation_ids`, even when the optional wait fails.** Credits are already
  spent by then; losing the id orphans a paid job. See `settleWait` in `src/server.ts`.
- **The cost guard fails closed.** If a reference clip's duration cannot be read, refuse the
  generation rather than submit on a guessed estimate.
- **Treat unknown generation statuses as still-running**, never as finished.
- **Local file uploads stay behind the `DARE_UPLOAD_ROOTS` allowlist**, and stay disabled on the
  HTTP transport. Without this, a prompt-injected model can have the server upload its own
  environment — which contains `DARE_CLIENT_TOKEN` — and read it back from the returned URL.

## Testing

```bash
npm run build
node scripts/smoke.mjs                      # offline, no credentials, no credits
DARE_CLIENT_TOKEN='eyJ...' npm run check    # live, read-only, free
```

For a live generation, start at the floor: `seedance-2-5`, 4 seconds, 480p, count 1 — about
0.88 credits. Never debug with a 30-second 720p batch.

## If a call fails

- `DARE_UNKNOWN_PROCEDURE` — the procedure was renamed. Re-derive from the bundles above.
- A schema/validation error on `generations.create` — the payload shape drifted. Compare
  `createInput` in `src/dare.ts` against the current `mutateAsync` call in `composer-view-*.js`.
- `DARE_UNAUTHORIZED` after previously working — the Clerk session was signed out. Copy a fresh
  `__client` cookie.

When you fix a contract drift, update the procedure table in `README.md` in the same commit.
