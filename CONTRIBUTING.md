# Contributing

Thanks for taking a look.

## Ground rules

**Never paste a `__client` token anywhere.** Not in an issue, a PR, a log excerpt, a test
fixture, or a screenshot. It is a live credential for a real account with real credits. Redact
it as `eyJ...` before sharing anything.

Same for storage URLs from your library — they are signed and can leak account context.

## Getting set up

```bash
git clone https://github.com/avi-aggarwal14/dare-mcp-server.git
cd dare-mcp-server
npm install          # `prepare` builds for you
npm run setup        # connect your own Dare account
```

## Checks before you open a PR

```bash
npm run build        # must typecheck clean, strict mode is on
npm run smoke        # credential-free: handshake, tool list, pricing
npm run check        # needs your own token; hits Dare read-only
```

`npm run smoke` is what CI runs. It never spends credits. `npm run check` only reads —
balance and library listing — so it is also free.

If your change touches generation, test it with `dry_run: true` first, then with the smallest
real job that proves the point (a 4s 480p Seedance 2.5 clip costs 20 credits).

## Useful things to contribute

- **A broken procedure.** Open the Dare web app, do the thing in the UI, capture the request in
  the network tab, redact the auth header, and paste the procedure name and JSON shape. The
  procedure names live in `src/dare.ts`.
- **Pricing drift.** The formula is in `src/catalog.ts` and documented in the README. If a real
  charge no longer matches the estimate, say which job and what you were actually billed.
- **A new model.** Dare's composer declares which spec keys each model accepts; models that send
  the wrong keys get rejected. Include the composer's payload for the new model.
- **Setup friction.** If `npx dare-mcp-server setup` confused you, that is a bug. Tell us where
  you got stuck and on what OS and browser.

## Code style

No linter, no formatter config — match what is already there. Two spaces, double quotes,
semicolons, explicit types on exported functions. Comments explain *why*, not *what*.

Tools are defined in `src/server.ts`. Every tool that spends credits must support `dry_run`,
must run through the cost guard, and must never be auto-retried after an auth failure —
Dare's create endpoint has no idempotency key.

## Releasing

Maintainer only:

```bash
npm version minor          # updates package.json
npm run sync:alias         # pulls alias/dare-mcp to the same version
# bump SERVER_VERSION in src/server.ts to match
# add a CHANGELOG.md entry
git push --follow-tags
```

Pushing a `v*` tag runs the publish workflow, which needs the `NPM_TOKEN` repository secret.
It publishes `dare-mcp-server`, waits for the registry to serve it, then publishes the
`dare-mcp` alias, which pins that exact version.

### The alias

`alias/dare-mcp` is a two-file package that forwards to the real CLI in-process. It holds the
shorter name on npm as a working package rather than a placeholder. It must never grow logic
of its own — if you find yourself editing `bin.js` for anything but resolution errors, the
change belongs in `src/`. `npm run check:alias` fails the build if its version drifts.
