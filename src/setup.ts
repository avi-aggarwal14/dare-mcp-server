/**
 * Interactive first-run wizard: `npx dare-mcp-server setup`.
 *
 * Walks a brand-new user through pasting their Dare `__client` cookie, proves it works
 * against Dare's live API, stores it with owner-only permissions, and registers the
 * server with Claude Code and/or the Claude desktop app.
 */
import { createInterface, type Interface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { loadConfig } from "./config.js";
import { ClerkTokenProvider } from "./auth.js";
import { DareRpcClient } from "./rpc.js";
import { DareService } from "./dare.js";
import { DareError } from "./errors.js";
import { configPath, readStoredConfig, writeStoredConfig } from "./store.js";
import { SERVER_VERSION } from "./server.js";

const MCP_KEY = "dare";

/* ------------------------------------------------------------------ output */

const ESC = "\u001b[";
const useColour = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (useColour ? `${ESC}${code}m${text}${ESC}0m` : text);
const bold = paint("1");
const dim = paint("2");
const green = paint("32");
const yellow = paint("33");
const red = paint("31");
const cyan = paint("36");

const say = (line = "") => console.log(line);
const step = (n: number, total: number, title: string) => say(`\n${bold(`[${n}/${total}]`)} ${bold(title)}`);
const ok = (line: string) => say(`  ${green("✓")} ${line}`);
const warn = (line: string) => say(`  ${yellow("!")} ${line}`);
const fail = (line: string) => say(`  ${red("✗")} ${line}`);
const note = (line: string) => say(`  ${dim(line)}`);

/* ------------------------------------------------------------------- input */

/** Resolves to null if the input stream closes first (piped input, Ctrl-D). */
function ask(rl: Interface, question: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const onClose = () => {
      if (settled) return;
      settled = true;
      say();
      resolve(null);
    };
    rl.once("close", onClose);
    rl.question(question, (answer) => {
      if (settled) return;
      settled = true;
      rl.off("close", onClose);
      resolve(answer.trim());
    });
  });
}

/** Reads a line without echoing it, so a pasted token never lands in scrollback. */
function askSecret(rl: Interface, question: string): Promise<string | null> {
  const input = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  if (!input.isTTY) return ask(rl, question);

  const rlAny = rl as unknown as { output?: NodeJS.WriteStream; _writeToOutput?: (s: string) => void };
  const output = rlAny.output;
  const restore = () => {
    rlAny._writeToOutput = (chunk: string) => output?.write(chunk);
  };

  let muted = false;
  rlAny._writeToOutput = (chunk: string) => {
    if (!muted) output?.write(chunk);
    else if (chunk.includes("\n")) output?.write("\n");
  };
  muted = true;

  return ask(rl, question).then((answer) => {
    muted = false;
    restore();
    return answer;
  });
}

async function confirm(rl: Interface, question: string, fallback = true): Promise<boolean> {
  const hint = fallback ? "Y/n" : "y/N";
  const raw = await ask(rl, `  ${question} ${dim(`[${hint}]`)} `);
  if (raw === null) return fallback;
  const answer = raw.toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

/* ------------------------------------------------------------------- token */

/** Accepts a bare JWT, a `__client=...` pair, or a whole cookie header, and returns the JWT. */
export function normaliseToken(raw: string): string {
  let value = raw.trim().replace(/^["']|["']$/g, "");
  const match = value.match(/__client=([^;\s]+)/);
  if (match) value = match[1];
  value = value.replace(/^__client=/, "").trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    // Already decoded.
  }
  return value.replace(/\s+/g, "");
}

export function looksLikeJwt(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

/* ------------------------------------------------------------------ config */

interface Target {
  key: "claude-code" | "claude-desktop";
  label: string;
  path: string;
  detected: boolean;
}

export function claudeCodeConfigPath(): string {
  return join(homedir(), ".claude.json");
}

export function claudeDesktopConfigPath(): string | null {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    case "linux":
      return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "Claude", "claude_desktop_config.json");
    default:
      return null;
  }
}

/** The MCP entry we register. No secret in it: the token lives in the credential store. */
function serverEntry(includeType: boolean): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    command: "npx",
    args: ["-y", "dare-mcp-server"],
  };
  if (includeType) entry.type = "stdio";
  return entry;
}

function readJson(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

/** Adds the server to a config file, backing up the original first. */
export function registerIn(path: string, includeType: boolean): { backup?: string } {
  let json: Record<string, any>;
  try {
    json = readJson(path);
  } catch (err: any) {
    throw new Error(`${path} is not valid JSON (${err.message}). Fix or move it, then rerun setup.`);
  }

  let backup: string | undefined;
  if (existsSync(path)) {
    backup = `${path}.dare-backup`;
    copyFileSync(path, backup);
  }

  if (!json.mcpServers || typeof json.mcpServers !== "object") json.mcpServers = {};
  json.mcpServers[MCP_KEY] = serverEntry(includeType);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  return { backup };
}

function claudeCliAvailable(): boolean {
  try {
    const probe = spawnSync(platform() === "win32" ? "where" : "which", ["claude"], { stdio: "ignore" });
    return probe.status === 0;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------- main */

export async function runSetup(): Promise<number> {
  const totalSteps = 4;

  say();
  say(bold(`  dare-mcp-server setup ${dim(`v${SERVER_VERSION}`)}`));
  say(dim("  Connects Claude to your Dare (trydare.com) account for video and image generation."));
  say();
  say(
    dim(
      "  Heads up: Dare has no public developer API. This server signs in as you with your own\n" +
        "  browser session and spends your own credits. Using it may sit outside Dare's terms.",
    ),
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    /* --- 1. token ------------------------------------------------------- */
    step(1, totalSteps, "Your Dare session token");

    const stored = readStoredConfig();
    let token = stored.clientToken;

    if (token) {
      ok(`Found a saved token in ${configPath()}`);
      if (await confirm(rl, "Replace it with a new one?", false)) {
        token = undefined;
      } else {
        note("Keeping the saved token.");
      }
    }

    if (!token) {
      say();
      note("Grab your token in the browser you use for Dare:");
      note("  1. Sign in at https://trydare.com");
      note("  2. Open DevTools  (macOS: Cmd+Option+I    Windows/Linux: F12)");
      note("  3. Application › Cookies › https://clerk.trydare.com");
      note("  4. Copy the Value of the __client cookie (a long string starting eyJ)");
      say();
      note("It is valid for about a year, so this is a one-time step.");
      note("Treat it like a password: it can spend your Dare credits.");
      say();

      for (let attempt = 1; attempt <= 3 && !token; attempt++) {
        const raw = await askSecret(rl, `  Paste the __client cookie ${dim("(hidden)")}: `);
        if (raw === null) {
          fail("Input closed before a token was entered.");
          note("Run `npx dare-mcp-server setup` in an interactive terminal.");
          return 1;
        }
        const candidate = normaliseToken(raw);
        if (!candidate) {
          fail("Nothing pasted.");
          continue;
        }
        if (!looksLikeJwt(candidate)) {
          fail("That does not look like the __client cookie (expected three dot-separated parts starting eyJ).");
          note("Make sure you copied the Value column, not the cookie name.");
          continue;
        }
        token = candidate;
      }

      if (!token) {
        say();
        fail("No usable token after three tries. Run setup again when you have it.");
        return 1;
      }
    }

    /* --- 2. verify ------------------------------------------------------ */
    step(2, totalSteps, "Checking it against Dare");

    const config = loadConfig({ clientToken: token });
    const auth = new ClerkTokenProvider(config);
    const dare = new DareService(new DareRpcClient(config, auth), config);

    try {
      await auth.getToken();
      ok("Session token minted");
    } catch (err) {
      fail("Dare rejected that token.");
      note(err instanceof DareError ? err.toAgentMessage() : String(err));
      say();
      note("Most common cause: the cookie came from a signed-out session, or was only partly copied.");
      note("Sign in again at https://trydare.com, recopy the __client value, and rerun setup.");
      return 1;
    }

    try {
      const balance: any = await dare.getCreditBalance();
      const credits = balance?.credits ?? balance?.balance ?? balance?.available ?? null;
      ok(`Account reachable — ${credits === null ? JSON.stringify(balance) : `${credits} credits available`}`);
    } catch (err) {
      warn("Token works but the balance call failed. Continuing anyway.");
      note(err instanceof DareError ? err.toAgentMessage() : String(err));
    }

    /* --- 3. save -------------------------------------------------------- */
    step(3, totalSteps, "Saving your credentials");

    const savedTo = writeStoredConfig({ clientToken: token });
    ok(`Stored in ${savedTo} ${dim("(owner-only permissions)")}`);
    note("Your Claude config files stay secret-free, so they are safe to sync or share.");

    /* --- 4. register ---------------------------------------------------- */
    step(4, totalSteps, "Adding Dare to Claude");

    const targets: Target[] = [];
    const codePath = claudeCodeConfigPath();
    targets.push({
      key: "claude-code",
      label: "Claude Code",
      path: codePath,
      detected: existsSync(codePath) || claudeCliAvailable(),
    });
    const desktopPath = claudeDesktopConfigPath();
    if (desktopPath) {
      targets.push({
        key: "claude-desktop",
        label: "Claude desktop app",
        path: desktopPath,
        detected: existsSync(desktopPath) || existsSync(dirname(desktopPath)),
      });
    }

    const registered: string[] = [];
    for (const target of targets) {
      const suffix = target.detected ? "" : dim(" (not detected on this machine)");
      if (!(await confirm(rl, `Add Dare to ${bold(target.label)}?${suffix}`, target.detected))) continue;
      try {
        const { backup } = registerIn(target.path, target.key === "claude-code");
        ok(`${target.label}: registered as "${MCP_KEY}" in ${target.path}`);
        if (backup) note(`Previous config backed up to ${backup}`);
        registered.push(target.label);
      } catch (err: any) {
        fail(`${target.label}: ${err.message}`);
      }
    }

    /* --- done ----------------------------------------------------------- */
    say();
    say(bold(green("  Setup complete.")));
    say();

    if (registered.includes("Claude Code")) {
      note('Claude Code: restart any open session, then run /mcp to confirm "dare" is connected.');
    }
    if (registered.includes("Claude desktop app")) {
      note("Claude desktop app: quit it fully and reopen for the server to appear.");
    }
    if (registered.length === 0) {
      note("Nothing registered. You can add it yourself with:");
      say();
      say(cyan("    claude mcp add dare --scope user -- npx -y dare-mcp-server"));
    }

    say();
    note("Then try asking Claude:");
    say(cyan('    "how many Dare credits do I have?"'));
    say(cyan('    "make me a 5 second cinematic shot of rain on a neon Tokyo street"'));
    say();
    note("Run `npx dare-mcp-server check` any time to re-test the connection.");
    say();

    return 0;
  } finally {
    rl.close();
  }
}
