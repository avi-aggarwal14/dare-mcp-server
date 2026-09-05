# Security

## What this server holds

Your Dare `__client` cookie. It is account-level access: anything that can read it can spend
your credits, read your generation library, and delete from it.

`dare-mcp-server setup` stores it at `~/.dare-mcp/config.json` with `0600` permissions, and
deliberately does **not** write it into `~/.claude.json` or `claude_desktop_config.json` —
those files get synced, backed up and occasionally committed.

The token is never logged, never sent anywhere except `clerk.trydare.com` and
`api.trydare.com`, and never returned in a tool result.

## Built-in guards

- **Cost guard.** `DARE_MAX_CREDITS_PER_CALL` (default 500) refuses any single generation above
  the limit. It fails closed: if a reference clip's duration cannot be read, the job is refused
  rather than submitted on a guessed estimate.
- **No blind retries.** Generation calls are never retried after an auth failure. Dare's create
  endpoint has no idempotency key, so a retry could bill you twice.
- **Upload allowlist.** `dare_upload_media` refuses local paths entirely unless
  `DARE_UPLOAD_ROOTS` names the directories it may read. Without it, a prompt-injected model
  could ask the server to upload your shell environment or Claude config.
- **SSRF protection on URL uploads.** The host is resolved first; loopback, private, link-local,
  CGNAT, multicast and IPv4-mapped/6to4/NAT64 forms are refused; the connection is pinned to the
  vetted address so DNS rebinding cannot race the check; every redirect hop is re-checked.
- **HTTP transport.** Refuses to start without a bearer token of at least 24 characters. Local
  file reads and URL uploads are both disabled on it regardless of configuration.

## If your token leaks

Sign out of Dare in the browser you copied it from. That invalidates the `__client` session
immediately. Then sign back in and run `npx dare-mcp-server setup` with the new value.

## Reporting a vulnerability

Open a [GitHub security advisory](https://github.com/avi-aggarwal14/dare-mcp-server/security/advisories/new)
rather than a public issue. Include reproduction steps and what an attacker gains.

Expect a first response within a week. This is a side project, not a funded one, so please be
patient — but anything that lets a third party spend someone's credits or read their token will
be treated as urgent.

**Do not include a real `__client` token in a report.** Redact it as `eyJ...`.

## Scope

Out of scope: Dare's own service, and the fact that this server uses a private API at all. That
last one is documented in the README as a known risk, not a vulnerability — Dare can break or
disallow this at any time.
