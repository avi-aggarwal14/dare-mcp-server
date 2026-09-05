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
| Credit pricing | verified against two real charges (20 and 7 credits, both predicted exactly) |
| Clerk token minting | verified live |
| `generations.create` | verified live (`outcome: "created"`, id returned, job ran) |
| Every read procedure | verified live; response shapes documented in README |
| Upload flow (`storage.generateUploadUrl` -> PUT -> `uploads.create`), `uploads.delete` | verified live |
| Per-model spec shapes | dry-run for every model, compared against Dare's composer |

Everything in the request path has been exercised against Dare's real servers, with one
exception: `generations.cancel` (input `{ id }`, same as get/delete, which both work).

## Distribution (v0.2.0 onward)

The package is published to npm as `dare-mcp-server`. Users install with
`npx dare-mcp-server setup` — no clone, no build. Keep that path working; it is the
documented install and everything in the README assumes it.

- `src/cli.ts` is the single bin. No args = stdio server (what Claude launches).
  Subcommands: `setup`, `check`, `http`, `--help`, `--version`.
  `dist/stdio.js` and `dist/check.js` still exist so pre-0.2 configs keep working.
- `src/store.ts` owns `~/.dare-mcp/config.json` (`0600`). `loadConfig` reads env first,
  then the store. **Never** write the token into a Claude config file; those get synced.
  `DARE_CONFIG_DIR` overrides the location, and tests must set it to a temp dir.
- `src/setup.ts` is the wizard. It validates the token against Dare live before saving,
  masks the paste, and backs up any config file it edits to `<path>.dare-backup`.
- Releasing: bump `package.json`, match `SERVER_VERSION` in `src/server.ts`, add a
  CHANGELOG entry, push a `v*` tag. `.github/workflows/publish.yml` does the rest and
  fails if the tag and the package version disagree. Needs the `NPM_TOKEN` secret.

When touching auth or error messages, remember the user-facing hint should point at
`npx dare-mcp-server setup`, not at the README.

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
  reference limits, and crucially *which keys each model's spec carries*. Mirrored field-for-field
  in `src/catalog.ts`; `createVideo` only emits a key when the model declares it. When Dare adds a
  model, copy its config block verbatim rather than guessing.
- `src-1-*.js` — the credit cost calculator. Also mirrored in `src/catalog.ts`. The rate tables
  in it are **dollars** of provider cost; the `l()` wrapper (`x1.5 / (49.99/750)`, rounded up)
  is what turns them into credits. Missing that wrapper understated every price by ~23x.
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
- **The cost guard fails closed.** A reference Dare cannot find is refused outright; a video
  reference Dare finds but cannot measure is priced at 30 seconds (Dare's own assumption), so
  the estimate can only ever be high, never low.
- **Treat unknown generation statuses as still-running**, never as finished.
- **Local file uploads stay behind the `DARE_UPLOAD_ROOTS` allowlist**, and stay disabled on the
  HTTP transport. Without this, a prompt-injected model can have the server upload its own
  environment — which contains `DARE_CLIENT_TOKEN` — and read it back from the returned URL.

## Testing

```bash
npm run build
node scripts/smoke.mjs                      # offline, no credentials, no credits
DARE_CLIENT_TOKEN='eyJ...' npm run check    # live, read-only, free (DARE_CONFIG_DIR to isolate)
```

For a live generation, start at the floor: `seedance-2-5`, 4 seconds, 480p, count 1 — 20
credits. A Seedance 2.5 job takes several minutes; poll with `wait_seconds` up to 900. Never
debug with a 30-second 720p batch (320 credits each).

## If a call fails

- `DARE_UNKNOWN_PROCEDURE` — the procedure was renamed. Re-derive from the bundles above.
- A schema/validation error on `generations.create` — the payload shape drifted. Compare
  `createInput` in `src/dare.ts` against the current `mutateAsync` call in `composer-view-*.js`.
- `DARE_UNAUTHORIZED` after previously working — the Clerk session was signed out. Copy a fresh
  `__client` cookie.
- Clerk's Frontend API refuses requests carrying both `Origin` and `Authorization` headers.
  `src/auth.ts` sends only the cookie; keep it that way.

When you fix a contract drift, update the procedure table in `README.md` in the same commit.
