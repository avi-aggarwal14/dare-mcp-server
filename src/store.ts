/**
 * On-disk credential store.
 *
 * The setup wizard writes the Dare `__client` token here (0600) instead of pasting it
 * into `claude_desktop_config.json` or `~/.claude.json`, so the secret lives in exactly
 * one file with tight permissions and the MCP entries stay copy-pasteable and shareable.
 *
 * Environment variables always win over this file.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export interface StoredConfig {
  clientToken?: string;
  maxCreditsPerCall?: number;
  uploadRoots?: string[];
}

export function configDir(): string {
  return process.env.DARE_CONFIG_DIR?.trim() || join(homedir(), ".dare-mcp");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

/** Reads the stored config. Never throws: a broken or missing file means "nothing stored". */
export function readStoredConfig(): StoredConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as StoredConfig;
  } catch {
    return {};
  }
}

/** Merges into the stored config and writes it back with owner-only permissions. */
export function writeStoredConfig(patch: StoredConfig): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const merged = { ...readStoredConfig(), ...patch };
  const path = configPath();
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
    chmodSync(dir, 0o700);
  } catch {
    // Best effort: Windows has no POSIX modes.
  }
  return path;
}
