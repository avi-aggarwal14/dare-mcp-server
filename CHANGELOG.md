# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-09-05

The "install it in one command" release.

### Added
- Published to npm. `npx -y dare-mcp-server` needs no clone and no build.
- `dare-mcp-server setup`: an interactive wizard that walks you through finding your Dare
  `__client` cookie, verifies it against Dare live, shows your credit balance, saves it, and
  registers the server with Claude Code and the Claude desktop app.
- Credential store at `~/.dare-mcp/config.json` (`0600`), so the token no longer has to live in
  your Claude config. `DARE_CLIENT_TOKEN` still wins when set. Override the location with
  `DARE_CONFIG_DIR`.
- Single CLI entry point with subcommands: `setup`, `check`, `http`, `--help`, `--version`.
- `CONTRIBUTING.md`, `SECURITY.md`, issue templates, and a tag-triggered npm publish workflow.

### Changed
- README rewritten for people who have never seen this repo: one-command install up top,
  browser walkthrough in a collapsible section, deep reference material kept below.
- `DARE_UNAUTHORIZED` and the no-credentials startup warning now point at
  `npx dare-mcp-server setup` instead of the README.
- The smoke test runs against an isolated config directory so it can never pick up a real token.

### Notes
- `dist/stdio.js` still works as a direct entry point; existing configs keep running.

## [0.1.0]

Initial release. Thirteen tools across generation, library, uploads and projects, covering
Seedance 2.5 and 2.0, Veo 3.1, Kling 3.0 Pro, Hailuo 2.3, Nano Banana 2, GPT Image 2 and
Seedream 5 Pro. Clerk session minting, Dare's exact credit pricing formula, cost guard, upload
allowlist, SSRF-hardened URL uploads, and an optional bearer-authenticated HTTP transport.

[0.2.0]: https://github.com/avi-aggarwal14/dare-mcp-server/releases/tag/v0.2.0
[0.1.0]: https://github.com/avi-aggarwal14/dare-mcp-server/releases/tag/v0.1.0
