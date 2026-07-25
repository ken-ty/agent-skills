/**
 * Locate the store repo that the commands operate on.
 *
 * The CLI (this code) and the store (your skills, catalog.json, skills.lock)
 * are separate git repos. Code therefore cannot derive the store from its own
 * location the way a single-repo layout could — the store path is configured
 * once and read back here.
 *
 * Resolution order:
 *   1. $AGENT_SKILLS_STORE                       env override — wins (CI, multi-store)
 *   2. ~/.config/agent-skills/config.json        { "store": "<abs path>" }
 *   3. none — caller decides (resolveStore throws; resolveStoreOrNull returns null)
 *
 * This module must not import ./paths.ts: paths.ts depends on it, and the cycle
 * would be real. It takes only what it needs from node:os directly.
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export const STORE_ENV = "AGENT_SKILLS_STORE";
export const CONFIG_DIR: string = path.join(homedir(), ".config", "agent-skills");
export const CONFIG_PATH: string = path.join(CONFIG_DIR, "config.json");

export type Config = { store: string };

/** Read the config file. Returns null when absent or unparseable. */
export function readConfig(): Config | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Config;
  } catch {
    return null;
  }
}

/** Write the config file, creating ~/.config/agent-skills as needed. */
export function writeConfig(cfg: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** Configured store path (env over config), resolved to absolute, or null. */
export function resolveStoreOrNull(): string | null {
  const env = process.env[STORE_ENV];
  if (env !== undefined && env.trim() !== "") return path.resolve(env);
  const cfg = readConfig();
  return cfg?.store !== undefined && cfg.store !== "" ? path.resolve(cfg.store) : null;
}

/** Configured store path, or throw with the fix. Use where a store is required. */
export function resolveStore(): string {
  const s = resolveStoreOrNull();
  if (s === null) {
    throw new Error(
      "No store configured.\n" +
        "  Create one:   agent-skills init <dir>\n" +
        "  Use existing: agent-skills link <dir>\n" +
        `  Or set ${STORE_ENV} to a store path.`,
    );
  }
  return s;
}
