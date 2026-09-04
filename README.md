# dare-mcp-server

An MCP server that gives Claude Code and Claude (Cowork / desktop) direct access to
[Dare](https://trydare.com) video generation — **Seedance 2.5**, Seedance 2.0, Veo 3.1,
Kling 3.0 Pro and Hailuo 2.3 — billed to your existing Dare credit balance.

> **Heads up.** Dare does not publish a developer API. This server talks to the same private
> oRPC endpoint (`api.trydare.com/rpc`) the Dare web app uses, authenticating as you with a
> Clerk session. It works today, but Dare can change that contract without notice, and using it
> may sit outside Dare's terms of service. Your account, your credits, your call.

## Tools

| Tool | Spends credits | What it does |
| --- | --- | --- |
| `dare_list_models` | no | Models with durations, qualities, aspect ratios, reference limits |
| `dare_estimate_cost` | no | Local credit estimate before you commit |
| `dare_get_credit_balance` | no | Current balance |
| `dare_generate_video` | **yes** | Text-to-video, Seedance 2.5 by default; optional reference media |
| `dare_generate_image` | **yes** | Stills via Nano Banana 2, GPT Image 2, Seedream 5 Pro |
| `dare_get_generation` | no | Poll status, get the output URL |
| `dare_list_generations` | no | Paginated library listing |
| `dare_cancel_generation` | no | Stop an in-flight job |
| `dare_delete_generation` | no | Delete from the library (destructive) |
| `dare_upload_media` | no | Upload a reference image/clip/audio, returns a `storage_key` |
| `dare_list_uploads` | no | Previously uploaded references |
| `dare_delete_upload` | no | Delete an uploaded reference (destructive) |
| `dare_list_projects` | no | Your Dare projects |

## Install

```bash
git clone <this repo> dare-mcp-server
cd dare-mcp-server
npm install
npm run build
```

Node 20 or newer.

## Get your Dare token

The server authenticates as you, using the long-lived Clerk `__client` cookie. It mints a fresh
60-second session token for every call, exactly as the Dare web app does.

1. Sign in at <https://trydare.com> in Chrome.
2. Open DevTools (`Cmd+Option+I`) → **Application** → **Storage** → **Cookies** →
   `https://clerk.trydare.com`.
3. Copy the **Value** of the `__client` cookie. It is a long JWT starting `eyJ...`.

That cookie is valid for about a year, so this is a one-time step unless you sign out.

> Treat it like a password: it grants full access to your Dare account and its credits.
> Keep it out of git and out of shared configs.

Verify it:

```bash
DARE_CLIENT_TOKEN='eyJ...' npm run check
```

You should see a minted token and your credit balance.

## Add to Claude Code

```bash
claude mcp add dare \
  --scope user \
  --env DARE_CLIENT_TOKEN='eyJ...' \
  --env DARE_MAX_CREDITS_PER_CALL=50 \
  --env DARE_UPLOAD_ROOTS="$HOME/Movies,$HOME/Pictures" \
  -- node /absolute/path/to/dare-mcp-server/dist/stdio.js
```

Then in any session:

```
> make me a 10 second 720p cinematic shot of rain on a neon Tokyo street, 16:9
```

Check it registered with `/mcp`.

## Add to Claude (Cowork / desktop app)

Edit the Claude desktop config:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "dare": {
      "command": "node",
      "args": ["/absolute/path/to/dare-mcp-server/dist/stdio.js"],
      "env": {
        "DARE_CLIENT_TOKEN": "eyJ...",
        "DARE_MAX_CREDITS_PER_CALL": "500",
        "DARE_UPLOAD_ROOTS": "/Users/you/Movies,/Users/you/Pictures"
      }
    }
  }
}
```

Restart the app. The Dare tools appear in the tools menu, and Cowork sessions can call them
alongside your files — generate a clip and have it written straight into a connected folder.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DARE_CLIENT_TOKEN` | — | **Required.** The `__client` cookie from `clerk.trydare.com`. |
| `DARE_MAX_CREDITS_PER_CALL` | `0` (off) | Refuse any single generation estimated above this many credits. |
| `DARE_UPLOAD_ROOTS` | — (blocked) | Comma-separated directories `dare_upload_media` may read local files from. Empty means local file reads are refused. |
| `DARE_ALLOW_URL_UPLOADS` | `true` | Allow uploading from a public URL. Private and link-local addresses are always refused. |
| `DARE_MAX_UPLOAD_BYTES` | `536870912` | Largest upload accepted. |
| `DARE_SESSION_TOKEN` | — | A ready-made 60s session JWT. Testing only. |
| `DARE_SESSION_ID` | auto | Pin a specific `sess_...` id instead of auto-detecting. |
| `DARE_REQUEST_TIMEOUT_MS` | `120000` | Per-request timeout. |
| `DARE_SERVER_URL` | `https://api.trydare.com` | Dare RPC base. |
| `DARE_CLERK_FAPI_URL` | `https://clerk.trydare.com` | Clerk Frontend API base. |

`DARE_MAX_CREDITS_PER_CALL` is worth setting. It is a client-side circuit breaker against a
model talking itself into a 10-variation 30-second batch (3,200 credits). 500 allows any single
Seedance 2.5 clip while blocking runaway batches. The guard fails closed: if a
reference clip's duration cannot be read, the generation is refused rather than submitted on
a guessed estimate.

`DARE_UPLOAD_ROOTS` is an allowlist, not a convenience. Without it, `dare_upload_media`
refuses local paths entirely — otherwise a prompt-injected model could ask the server to
upload your shell environment or Claude config, both of which contain `DARE_CLIENT_TOKEN`.
Point it at the folders that actually hold your source footage.

## Credit costs

Dare prices every job as **provider cost in dollars, times 1.5, converted at 750 credits per
$49.99, rounded up** to the nearest 1, 5 or 10 credits. The server reproduces that formula
exactly; it was checked against real charges (a 4s 480p Seedance 2.5 clip billed 20 credits, as
predicted). Typical figures:

| Job | Credits |
| --- | --- |
| Seedance 2.5, 4s, 480p | 20 |
| Seedance 2.5, 8s, 720p | 90 |
| Seedance 2.5, 10s, 720p | 110 |
| Seedance 2.5, 30s, 480p | 150 |
| Seedance 2.5, 30s, 720p | 320 |
| Seedance 2.0 Fast, 5s, 480p | 15 |
| Seedance 2.0, 15s, 4K | 530 |
| Veo 3.1, 8s, 1080p | 80 |
| Kling 3.0 Pro, 5s | 20 |
| Hailuo 2.3 Pro (fixed 6s) | 15 |
| Nano Banana 2 image, 2K | 4 |
| GPT Image 2, 1:1 | 5 |

Attaching a **video** reference applies a 0.6x multiplier on Seedance models, and on Seedance
2.5 the reference clip's own seconds are billed on top. Image and audio references do not
change the price.

Always sanity-check with `dare_estimate_cost` before a batch.

## Reference-driven generation

```
1. dare_upload_media  { file_path: "/Users/you/shots/hero.png" }
     -> storage_key: "uploads/abc123..."
2. dare_generate_video {
     prompt: "the character from the reference walks toward camera through fog",
     reference_storage_keys: ["uploads/abc123..."],
     duration_seconds: 8
   }
```

Seedance 2.5 takes up to 50 references (30 image, 10 video, 10 audio), 30 combined seconds per
kind. With a video reference attached it derives duration and aspect ratio automatically.

## Remote HTTP (optional)

A stateless streamable-HTTP entrypoint is included for hosting the server behind a URL:

```bash
DARE_CLIENT_TOKEN='eyJ...' \
DARE_MCP_BEARER_TOKEN="$(openssl rand -hex 32)" \
  PORT=3000 npm run start:http
```

`POST /mcp`, health check at `/health`. The server **refuses to start** without a bearer token
of at least 24 characters, since these tools spend real money. DNS-rebinding protection is on by
default and scoped to localhost; widen it with `DARE_ALLOWED_HOSTS` / `DARE_ALLOWED_ORIGINS` when
deploying behind a domain. Local file uploads and URL uploads are both disabled on this transport
regardless of configuration.

## Troubleshooting

**`DARE_UNAUTHORIZED`** — the `__client` cookie is missing, stale, or you signed out of Dare in
that browser. Re-copy it and re-run `npm run check`.

**`DARE_UNKNOWN_PROCEDURE`** — Dare changed their internal RPC. The procedure names live in
`src/dare.ts`; compare against a fresh capture from the web app's network tab.

**`DARE_INSUFFICIENT_CREDITS`** — the error reports credits required versus available.

**`DARE_COST_GUARD`** — your own `DARE_MAX_CREDITS_PER_CALL` limit fired. Working as intended.

**`DARE_REFERENCE_UNKNOWN`** — a reference storage key could not be resolved, so the cost could
not be estimated. Check the key came from `dare_upload_media` or `dare_list_uploads`.

**`DARE_UPLOAD_FORBIDDEN`** — the file is outside `DARE_UPLOAD_ROOTS`, or you are on the HTTP
transport where local reads are disabled.

## Security notes

- The `__client` token is account-level access. Anything that can read your MCP config can
  spend your credits.
- `dare_generate_*` calls are never retried automatically after an auth failure. Dare's create
  endpoint has no idempotency key, so a blind retry could bill you twice.
- Uploading from a URL refuses loopback, link-local and private address ranges.

## How it works

```
Claude Code / Cowork
        │  MCP (stdio)
        ▼
  dare-mcp-server
        │  1. POST clerk.trydare.com/v1/client/sessions/{id}/tokens   (__client cookie)
        │     -> 60s session JWT, cached 45s
        │  2. POST api.trydare.com/rpc/{procedure}                    (Bearer JWT)
        │     oRPC envelope: { json, meta }
        ▼
    Dare backend
```

Uploads are three steps: `storage.generateUploadUrl` -> `PUT` to signed storage -> `uploads.create`.

### Procedures used

| Procedure | Input |
| --- | --- |
| `generations.create` | `{ spec, count, projectId?, metaEventId, timezone }` |
| `generations.get` / `cancel` / `delete` | `{ id }` |
| `generations.getMediaInfo` | `{ storageKey }` |
| `libraryItems.list`, `uploads.list` | `{ cursor, limit }` |
| `storage.generateUploadUrl` | `{ contentType, fileExtension }` |
| `uploads.create` | `{ storageKey, name, prompt, projectId, timezone }` |
| `uploads.delete` | `{ id }` |
| `credits.getBalance`, `projects.list` | no input |

`spec` for a video is `{ tool: "create_video", prompt, model, aspectRatio, quality, duration?, audioEnabled?, context? }`,
where `duration` is a string like `"8s"` and `context` is `{ mediaStorageKeys, webLinkIds }`.

Generation statuses seen in the wild: `queued` and `processing` while running, `succeeded`
or `failed` at the end. The finished file is at `generation.outputAsset.storageUrl`. Anything
unrecognised is treated as still-running, so a renamed in-progress state is never mistaken
for a finished one.

## Licence

MIT. Not affiliated with, endorsed by, or supported by Dare.
