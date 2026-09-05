# dare-mcp-server

[![npm](https://img.shields.io/npm/v/dare-mcp-server?color=cb3837&logo=npm)](https://www.npmjs.com/package/dare-mcp-server)
[![node](https://img.shields.io/badge/node-%E2%89%A520-5fa04e?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![licence](https://img.shields.io/badge/licence-MIT-blue)](./LICENSE)

**Generate video and images from inside Claude, billed to your own [Dare](https://trydare.com) credits.**

Ask Claude for a shot and it makes one — Seedance 2.5, Seedance 2.0, Veo 3.1, Kling 3.0 Pro,
Hailuo 2.3 for video, Nano Banana 2, GPT Image 2 and Seedream 5 Pro for stills. No new
subscription, no API key to buy: it spends the Dare credits you already have.

```
> make me a 10 second 720p cinematic shot of rain on a neon Tokyo street, 16:9

  Estimated 110 credits (you have 4,280). Generating…
  Done: https://storage.trydare.com/…/rain-tokyo.mp4
```

Works with **Claude Code**, the **Claude desktop app**, and **Cowork**.

> [!IMPORTANT]
> Dare does not publish a developer API. This server talks to the same private endpoint the
> Dare web app uses, signed in as you with your own browser session. It works today — every
> tool here has been exercised against Dare's live servers, including a generation run to
> completion — but Dare can change that contract without notice, and using it may sit outside
> Dare's terms of service. Your account, your credits, your call.

---

## Install

You need **[Node.js](https://nodejs.org) 20 or newer**. Check with `node --version`; if that
errors, install the LTS build from nodejs.org (on a Mac, `brew install node` also works).

Then run one command in your terminal:

```bash
npx dare-mcp-server setup
```

That is the whole install. The wizard:

1. shows you where to find your Dare token (four clicks in your browser),
2. checks it against Dare and prints your credit balance,
3. saves it to `~/.dare-mcp/config.json` with owner-only permissions,
4. adds Dare to Claude Code and/or the Claude desktop app for you.

Restart Claude when it finishes. In Claude Code, `/mcp` should now list **dare**.

`npx dare-mcp setup` works too — [`dare-mcp`](https://www.npmjs.com/package/dare-mcp) is a
short alias that forwards to the same package.

<details>
<summary><b>Step 2 in detail: finding your Dare token</b></summary>

The server signs in as you, using the long-lived Clerk `__client` cookie from your browser.
It mints a fresh 60-second session token for every call, exactly as the Dare web app does.

1. Sign in at <https://trydare.com> in Chrome, Edge, Arc or Brave.
2. Open DevTools — **Cmd+Option+I** on macOS, **F12** on Windows and Linux.
3. Go to the **Application** tab → **Storage** → **Cookies** → `https://clerk.trydare.com`.
   (In Firefox and Safari the tab is called **Storage** instead.)
4. Find the row named `__client` and copy its **Value** — a long string starting `eyJ`.
   Copy the value, not the name.
5. Paste it into the wizard. Your terminal will not echo it back.

The cookie is valid for about a year, so this is a one-time step unless you sign out of Dare.

**Treat it like a password.** It grants full access to your Dare account and can spend your
credits. The wizard keeps it in one file with `0600` permissions and deliberately does *not*
write it into your Claude config, so your Claude settings stay safe to sync or share.

</details>

<details>
<summary><b>Prefer to do it by hand?</b></summary>

**Claude Code**

```bash
claude mcp add dare --scope user -- npx -y dare-mcp-server
```

**Claude desktop app** — edit the config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "dare": {
      "command": "npx",
      "args": ["-y", "dare-mcp-server"]
    }
  }
}
```

Then quit and reopen the app.

Both of these read your token from `~/.dare-mcp/config.json`. If you would rather pass it as an
environment variable (CI, containers, a shared machine), set `DARE_CLIENT_TOKEN` instead — it
takes precedence over the stored file. See [Configuration](#configuration).

</details>

<details>
<summary><b>Running from source</b></summary>

```bash
git clone https://github.com/avi-aggarwal14/dare-mcp-server.git
cd dare-mcp-server
npm install          # builds automatically
npm run setup        # same wizard
```

Point Claude at `node /absolute/path/to/dare-mcp-server/dist/cli.js` instead of `npx`.

</details>

## Check it works

```bash
npx dare-mcp-server check
```

Mints a token, reads your balance, lists a few library items. Run it any time the tools start
failing — it is the fastest way to tell a stale cookie from a Dare outage.

## First things to try

Once Claude has restarted, just ask in plain English:

```
> how many Dare credits do I have?
> what video models can I use, and what do they cost?
> make a 5 second clip of a paper boat going down a rain gutter, cinematic, 16:9
> use ~/shots/hero.png as a reference and animate the character walking toward camera
> what's in my Dare library from this week?
```

Claude will quote you a credit estimate before spending anything, and you can always ask it to
do a dry run first.

## Tools

| Tool | Spends credits | What it does |
| --- | --- | --- |
| `dare_list_models` | no | Models with durations, qualities, aspect ratios, reference limits |
| `dare_estimate_cost` | no | Local credit estimate before you commit |
| `dare_get_credit_balance` | no | Current balance |
| `dare_generate_video` | **yes** | Text-to-video, Seedance 2.5 by default; optional reference media. `dry_run: true` previews the spec and price for free |
| `dare_generate_image` | **yes** | Stills via Nano Banana 2, GPT Image 2, Seedream 5 Pro. Supports `dry_run` |
| `dare_get_generation` | no | Poll status, get the output URL |
| `dare_list_generations` | no | Paginated library listing |
| `dare_cancel_generation` | no | Stop an in-flight job |
| `dare_delete_generation` | no | Delete from the library (destructive) |
| `dare_upload_media` | no | Upload a reference image/clip/audio, returns a `storage_key` |
| `dare_list_uploads` | no | Previously uploaded references |
| `dare_delete_upload` | no | Delete an uploaded reference (destructive) |
| `dare_list_projects` | no | Your Dare projects |

## CLI

| Command | What it does |
| --- | --- |
| `npx dare-mcp-server setup` | Interactive first-run wizard |
| `npx dare-mcp-server check` | Verify credentials, print credit balance |
| `npx dare-mcp-server` | Start the MCP server on stdio (Claude runs this for you) |
| `npx dare-mcp-server http` | Optional HTTP transport for self-hosting |
| `npx dare-mcp-server --help` | Everything above |

## Configuration

Credentials are read in this order, first hit wins:

1. `DARE_CLIENT_TOKEN` in the environment
2. `~/.dare-mcp/config.json` (written by `setup`)

The stored file is plain JSON, so you can edit it directly:

```json
{
  "clientToken": "eyJ...",
  "maxCreditsPerCall": 500,
  "uploadRoots": ["/Users/you/Movies", "/Users/you/Pictures"]
}
```

Everything else is environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DARE_CLIENT_TOKEN` | from stored config | The `__client` cookie from `clerk.trydare.com`. Required one way or the other. |
| `DARE_CONFIG_DIR` | `~/.dare-mcp` | Where the stored config lives. |
| `DARE_MAX_CREDITS_PER_CALL` | `500` | Refuse any single generation estimated above this many credits. `0` disables. |
| `DARE_UPLOAD_ROOTS` | — (blocked) | Comma-separated directories `dare_upload_media` may read local files from. Empty means local file reads are refused. |
| `DARE_ALLOW_URL_UPLOADS` | `true` | Allow uploading from a public URL. Private and link-local addresses are always refused. |
| `DARE_MAX_UPLOAD_BYTES` | `536870912` | Largest upload accepted. |
| `DARE_SESSION_TOKEN` | — | A ready-made 60s session JWT. Testing only. |
| `DARE_SESSION_ID` | auto | Pin a specific `sess_...` id instead of auto-detecting. |
| `DARE_REQUEST_TIMEOUT_MS` | `120000` | Per-request timeout. |
| `DARE_SERVER_URL` | `https://api.trydare.com` | Dare RPC base. |
| `DARE_CLERK_FAPI_URL` | `https://clerk.trydare.com` | Clerk Frontend API base. |

`DARE_MAX_CREDITS_PER_CALL` is a client-side circuit breaker against a model talking itself
into a 10-variation 30-second batch (3,200 credits). The default of 500 allows any single
Seedance 2.5 clip while blocking runaway batches; raise it deliberately when you want a batch.
The estimate is conservative in the one place it cannot be exact: a video reference whose
length Dare cannot report is priced at 30 seconds, which is Dare's own assumption. The guard fails closed: if a
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

Seedance 2.5 takes up to 50 references (30 image, 10 video, 10 audio), each clip 2–30s, 30
combined seconds per kind. With a video reference attached it derives duration and aspect ratio
automatically. Seedance 2.0 models take 12 (9/3/3), 15s combined, and need a visual reference
alongside any audio one. Veo 3.1 takes up to 3 images and is then fixed at 8 seconds. Kling and
Hailuo take no references at all.

## Remote HTTP (optional)

A stateless streamable-HTTP entrypoint is included for hosting the server behind a URL:

```bash
DARE_CLIENT_TOKEN='eyJ...' \
DARE_MCP_BEARER_TOKEN="$(openssl rand -hex 32)" \
  PORT=3000 npx dare-mcp-server http
```

`POST /mcp`, health check at `/health`. The server **refuses to start** without a bearer token
of at least 24 characters, since these tools spend real money. DNS-rebinding protection is on by
default and scoped to localhost; widen it with `DARE_ALLOWED_HOSTS` / `DARE_ALLOWED_ORIGINS` when
deploying behind a domain. Local file uploads and URL uploads are both disabled on this transport
regardless of configuration.

## Troubleshooting

**`DARE_UNAUTHORIZED`** — the `__client` cookie is missing, stale, or you signed out of Dare in
that browser. Run `npx dare-mcp-server setup` again with a fresh value.

**`DARE_UNKNOWN_PROCEDURE`** — Dare changed their internal RPC. The procedure names live in
`src/dare.ts`; compare against a fresh capture from the web app's network tab.

**`DARE_INSUFFICIENT_CREDITS`** — the error reports credits required versus available.

**`DARE_COST_GUARD`** — your own `DARE_MAX_CREDITS_PER_CALL` limit fired. Working as intended.

**`DARE_REFERENCE_UNKNOWN`** — a reference storage key could not be resolved, so the cost could
not be estimated. Check the key came from `dare_upload_media` or `dare_list_uploads`.

**`DARE_UPLOAD_FORBIDDEN`** — the file is outside `DARE_UPLOAD_ROOTS`, or you are on the HTTP
transport where local reads are disabled.

## Security notes

- The `__client` token is account-level access. Anything that can read it can spend your credits.
  `setup` therefore stores it in `~/.dare-mcp/config.json` at `0600` rather than in your Claude
  config, which is often synced, backed up or committed.
- `dare_generate_*` calls are never retried automatically after an auth failure. Dare's create
  endpoint has no idempotency key, so a blind retry could bill you twice.
- Uploading from a URL resolves the host first, refuses loopback, private, link-local, CGNAT,
  multicast and IPv4-mapped/6to4/NAT64 forms of those, pins the connection to the vetted address
  so DNS rebinding cannot race the check, and re-checks every redirect hop.

## How it works

```
Claude Code / desktop / Cowork
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

`spec` carries only the keys the chosen model declares, exactly as Dare's composer builds it:
Seedance models send `{ tool, prompt, model, audioEnabled, aspectRatio, duration, quality, context? }`,
Kling omits `quality`, Hailuo sends `{ tool, prompt, model }` and nothing else, GPT Image 2 has no
`quality`. `duration` is a string like `"8s"`, `context` is `{ mediaStorageKeys, webLinkIds }`, and
every attached asset is also referenced in the prompt as `@<storageKey>`. Use `dry_run: true` on
either generate tool to see the spec for any combination without submitting.

Errors are mapped so an agent can act on them: a missing record is `DARE_NOT_FOUND`, a renamed
procedure `DARE_UNKNOWN_PROCEDURE`, a schema mismatch `DARE_BAD_REQUEST` with the field-level
issues included.

Generation statuses seen in the wild: `queued` and `processing` while running, `succeeded`
or `failed` at the end. The finished file is at `generation.outputAsset.storageUrl`. Anything
unrecognised is treated as still-running, so a renamed in-progress state is never mistaken
for a finished one.

## Uninstall

```bash
claude mcp remove dare --scope user     # Claude Code
rm -rf ~/.dare-mcp                      # your stored token
```

For the desktop app, delete the `"dare"` entry from `claude_desktop_config.json`. Nothing else
is installed — `npx` does not leave the package behind.

## Contributing

Issues and pull requests are welcome, especially:

- Dare changed a procedure name or spec shape and something broke
- pricing drifted from the table above
- a model was added or removed from Dare's composer

```bash
git clone https://github.com/avi-aggarwal14/dare-mcp-server.git
cd dare-mcp-server
npm install
npm run build
npm run check        # needs a real token
npm run inspect      # MCP Inspector against a local build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md). Please never paste a `__client` token into an issue,
a log, or a test fixture — it is a live credential.

## Licence

MIT. Not affiliated with, endorsed by, or supported by Dare. "Dare", "Seedance", "Veo", "Kling"
and "Hailuo" belong to their respective owners.
