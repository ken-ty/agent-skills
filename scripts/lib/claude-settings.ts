/**
 * Claude Code's global settings, as a store declares them and as this machine
 * has them. Shared by `agent-skills settings` and `doctor`.
 *
 * The store's declaration (`claudeSettings` in agent-skills.json) is the
 * reviewed copy; `~/.claude/settings.json` is what Claude Code reads. They are
 * kept apart on purpose — Claude Code writes its own settings ("always allow",
 * `/config`), so a symlink would turn every one of those writes into an
 * uncommitted change in the store. Comparing the two is therefore semantic,
 * not byte-wise:
 *
 *   - key order is ignored, and string arrays (permissions.allow, …) are sets
 *   - the home directory is spelled three ways in practice — `/Users/<you>/…`
 *     (and `//Users/<you>/…` in a permission rule), `$HOME/…`, `~/…` — and all
 *     three mean the same file, so they compare equal. The store can only hold
 *     the `~/` form: its audit rejects a committed home path.
 */
import fs from "node:fs";
import path from "node:path";
import { HOME } from "./paths.ts";

export const CLAUDE_SETTINGS: string = path.join(HOME, ".claude", "settings.json");
export const CLAUDE_HOOKS_DIR: string = path.join(HOME, ".claude", "hooks");

/** The permission lists `settings import` carries back into the declaration. */
export const PERMISSION_LISTS = ["allow", "ask", "deny"] as const;

export type Settings = Record<string, unknown>;

export class SettingsError extends Error {
  readonly actionable = true;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse a settings file. Null when it does not exist; throws when it is not a JSON object. */
export function readSettings(file: string): { text: string; json: Settings } | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SettingsError(`${file}: cannot read (${(e as Error).message})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new SettingsError(`${file}: not valid JSON (${(e as Error).message})`);
  }
  if (!isObject(json)) throw new SettingsError(`${file}: must be a JSON object`);
  return { text, json };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HOME_RE = new RegExp(`/?${escapeRe(HOME)}(?![\\w.-])|\\$\\{HOME\\}|\\$HOME(?!\\w)`, "g");

/** Every spelling of the home directory, as `~`. `//<home>/x` (a permission rule's absolute form) included. */
export function normHome(s: string): string {
  return s.replace(HOME_RE, "~");
}

/** The inverse, for a path that will be opened: `~/x`, `$HOME/x` -> `<home>/x`. */
export function expandHome(s: string): string {
  return s.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, HOME);
}

/** JSON with sorted keys and normalised home paths, for equality only. */
function canon(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(normHome(v));
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

const show = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * One difference, read in the direction `apply` would move things:
 *   add     declared only — apply brings it onto this machine
 *   remove  machine only — apply drops it (`settings import` keeps a permission)
 *   change  both have the key with different values
 */
export type DiffEntry = {
  key: string;
  op: "add" | "remove" | "change";
  text: string;
  /** For `change`: what the machine has now. */
  was?: string;
};

/** A hook registration as one comparable line: `Event [matcher] command (timeout)`. */
function hookLines(hooks: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!isObject(hooks)) return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      out.set(`${event} ${canon(groups)}`, `${event} ${show(groups)}`);
      continue;
    }
    for (const g of groups) {
      const matcher = isObject(g) && typeof g.matcher === "string" && g.matcher !== "" ? ` [${g.matcher}]` : "";
      const list = isObject(g) && Array.isArray(g.hooks) ? g.hooks : [g];
      for (const h of list) {
        const { command, timeout, type, ...rest }: Record<string, unknown> = isObject(h) ? h : { command: h };
        const body =
          (type !== undefined && type !== "command" ? `${show(type)} ` : "") +
          (command !== undefined ? show(command) : "") +
          (timeout !== undefined ? ` (timeout ${show(timeout)})` : "") +
          (Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "");
        const text = `${event}${matcher}: ${body}`;
        out.set(canon(text), text);
      }
    }
  }
  return out;
}

function setDiff(key: string, declared: Map<string, string>, machine: Map<string, string>, out: DiffEntry[]): void {
  for (const [k, text] of declared) if (!machine.has(k)) out.push({ key, op: "add", text });
  for (const [k, text] of machine) if (!declared.has(k)) out.push({ key, op: "remove", text });
}

const asSet = (arr: unknown[]): Map<string, string> => new Map(arr.map((v) => [canon(v), show(v)]));

function walk(key: string, d: unknown, m: unknown, out: DiffEntry[]): void {
  if (key === "hooks") {
    setDiff(key, hookLines(d), hookLines(m), out);
    return;
  }
  if (isObject(d) && isObject(m)) {
    const keys = [...Object.keys(d), ...Object.keys(m).filter((k) => !(k in d))];
    for (const k of keys) {
      const sub = key === "" ? k : `${key}.${k}`;
      if (!(k in m)) out.push({ key: sub, op: "add", text: show(d[k]) });
      else if (!(k in d)) out.push({ key: sub, op: "remove", text: show(m[k]) });
      else walk(sub, d[k], m[k], out);
    }
    return;
  }
  if (Array.isArray(d) && Array.isArray(m)) {
    setDiff(key, asSet(d), asSet(m), out);
    return;
  }
  if (canon(d) !== canon(m)) out.push({ key, op: "change", text: show(d), was: show(m) });
}

/** Semantic differences between the declaration and this machine's settings. Empty = they agree. */
export function diffSettings(declared: Settings, machine: Settings): DiffEntry[] {
  const out: DiffEntry[] = [];
  walk("", { hooks: {}, ...declared }, { hooks: {}, ...machine }, out);
  return out;
}

const SIGN = { add: "+", remove: "-", change: "~" } as const;

/** Render a diff grouped by key, in the direction `apply` would go. */
export function formatDiff(entries: DiffEntry[]): string {
  const lines: string[] = [];
  let last = "";
  for (const e of entries) {
    if (e.key !== last) {
      lines.push(e.key);
      last = e.key;
    }
    lines.push(
      e.op === "change" ? `  ~ ${e.was} -> ${e.text}` : `  ${SIGN[e.op]} ${e.text}`,
    );
  }
  return lines.join("\n");
}

/** Permission entries the machine has and the declaration lacks, in the store's `~/` form. */
export function machineOnlyPermissions(
  declared: Settings,
  machine: Settings,
): Array<{ list: (typeof PERMISSION_LISTS)[number]; item: string }> {
  const out: Array<{ list: (typeof PERMISSION_LISTS)[number]; item: string }> = [];
  const dp = isObject(declared.permissions) ? declared.permissions : {};
  const mp = isObject(machine.permissions) ? machine.permissions : {};
  for (const list of PERMISSION_LISTS) {
    const have = new Set((Array.isArray(dp[list]) ? dp[list] : []).map((v) => canon(v)));
    for (const v of Array.isArray(mp[list]) ? mp[list] : []) {
      if (typeof v !== "string" || have.has(canon(v))) continue;
      have.add(canon(v));
      out.push({ list, item: normHome(v) });
    }
  }
  return out;
}

/** Append entries to the declaration's permission lists. Mutates and returns it. */
export function addPermissions(
  declared: Settings,
  items: Array<{ list: (typeof PERMISSION_LISTS)[number]; item: string }>,
): Settings {
  if (items.length === 0) return declared;
  if (!isObject(declared.permissions)) declared.permissions = {};
  const perms = declared.permissions as Record<string, unknown>;
  for (const { list, item } of items) {
    if (!Array.isArray(perms[list])) perms[list] = [];
    (perms[list] as unknown[]).push(item);
  }
  return declared;
}

/**
 * Scripts the declared hooks run from `~/.claude/hooks/`, resolved on this
 * machine. Only the first word of each command is taken as the program; a
 * command that starts with an interpreter (`python3 ~/…`) is not followed.
 */
export function declaredHookScripts(declared: Settings): Array<{ command: string; file: string }> {
  const out: Array<{ command: string; file: string }> = [];
  const seen = new Set<string>();
  const hooks = declared.hooks;
  if (!isObject(hooks)) return out;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of isObject(g) && Array.isArray(g.hooks) ? g.hooks : []) {
        if (!isObject(h) || typeof h.command !== "string") continue;
        const first = h.command.trim().split(/\s+/)[0]?.replace(/^["']|["']$/g, "") ?? "";
        const file = expandHome(first);
        if (!file.startsWith(CLAUDE_HOOKS_DIR + path.sep) || seen.has(file)) continue;
        seen.add(file);
        out.push({ command: h.command, file });
      }
    }
  }
  return out;
}
