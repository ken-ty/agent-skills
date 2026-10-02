/**
 * Where things live inside a store, as the store itself declares it.
 *
 * A store may carry `agent-skills.json` at its root:
 *
 *   {
 *     "layout": { "skills": "agents/skills", "agentsMd": "agents/AGENTS.md",
 *                 "catalog": "catalog.json", "lock": "skills.lock" },
 *     "links":  [ { "from": "agents/rulebooks", "to": "~/.agents/rulebooks" } ],
 *     "project": "agents/project"
 *   }
 *
 * `project` names the directory of per-level templates that `project init`
 * places into other repos. It has no default: a store without it simply has
 * no project templates, so it lives beside `layout` rather than in it (every
 * `layout` key has a default and is checked for existence on that basis).
 *
 * The file is optional and so is every key in it. A store without one keeps
 * the layout this tool has always assumed, so existing stores need no change.
 * The point of the file is the other direction: a store that wants its own
 * top level for its own housekeeping can move what it distributes elsewhere
 * and say so, instead of the CLI hard-coding one arrangement for everyone.
 *
 * Every path in it is relative to the store root and must stay inside it. A
 * declaration that escapes the store would make `link` wire `~/.agents` at
 * something the store's audit hook never sees, which defeats the reason the
 * store holds these files at all.
 *
 * This module must not import ./paths.ts: paths.ts depends on it.
 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export const DECLARATION_FILE = "agent-skills.json";

export type LayoutKey = "skills" | "agentsMd" | "catalog" | "lock";

export const LAYOUT_KEYS: ReadonlyArray<LayoutKey> = ["skills", "agentsMd", "catalog", "lock"];

/** The layout every store had before declarations existed. */
export const DEFAULT_LAYOUT: Readonly<Record<LayoutKey, string>> = {
  skills: "skills",
  agentsMd: "agents/AGENTS.md",
  catalog: "catalog.json",
  lock: "skills.lock",
};

/** A store-owned path wired into `$HOME` by `link` / `distribute`. */
export type StoreLink = {
  /** As written, store-relative. */
  fromRel: string;
  /** As written, `~/…`. */
  toRaw: string;
  /** Absolute, inside the store. */
  from: string;
  /** Absolute, under `$HOME`. */
  to: string;
};

export type StoreLayout = {
  root: string;
  /** Whether `agent-skills.json` exists at all. */
  declared: boolean;
  /** Store-relative paths (posix separators), defaults filled in. */
  rel: Record<LayoutKey, string>;
  /** Keys the file actually set, as opposed to defaulted. */
  explicit: Set<LayoutKey>;
  /** Absolute paths. */
  abs: Record<LayoutKey, string>;
  links: StoreLink[];
  /** Declared `project` templates dir, or null when the store has none. */
  project: { rel: string; abs: string } | null;
};

/** Thrown for a malformed declaration. `actionable` makes run.js print it without a stack. */
export class LayoutError extends Error {
  readonly actionable = true;
}

/**
 * Validate one store-relative path. Returns it normalised to posix form.
 *
 * Both separators are accepted on input so a declaration written on Windows
 * still reads elsewhere, and both absolute forms are rejected on every
 * platform: a store is shared between machines, so "absolute on this OS" is
 * not the question.
 */
function storeRelative(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LayoutError(`${what} must be a non-empty string`);
  }
  const slashed = value.replace(/\\/g, "/");
  if (path.posix.isAbsolute(slashed) || path.win32.isAbsolute(value) || slashed.startsWith("~")) {
    throw new LayoutError(`${what} is "${value}" — it must be relative to the store root`);
  }
  const norm = path.posix.normalize(slashed).replace(/\/+$/, "");
  if (norm === "." || norm === "") {
    throw new LayoutError(`${what} is "${value}" — it must name something inside the store, not the root`);
  }
  if (norm === ".." || norm.startsWith("../")) {
    throw new LayoutError(`${what} is "${value}" — it points outside the store`);
  }
  return norm;
}

/** `~/…` only: a store distributes into its owner's home, nowhere else. */
function homeTarget(value: unknown, what: string, home: string): string {
  if (typeof value !== "string" || !/^~[/\\]./.test(value)) {
    throw new LayoutError(`${what} must be a path under the home directory, written as "~/…"`);
  }
  const rest = path.posix.normalize(value.slice(2).replace(/\\/g, "/")).replace(/\/+$/, "");
  if (rest === "." || rest === ".." || rest.startsWith("../")) {
    throw new LayoutError(`${what} is "${value}" — it must stay under the home directory`);
  }
  return path.join(home, ...rest.split("/"));
}

/**
 * Read and validate a store's declaration. Throws LayoutError when the file
 * exists but cannot be trusted; never throws for a store that has none.
 */
export function readLayout(root: string, home: string = homedir()): StoreLayout {
  const file = path.join(root, DECLARATION_FILE);
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new LayoutError(`${file}: cannot read (${(e as Error).message})`);
    }
  }

  const rel: Record<LayoutKey, string> = { ...DEFAULT_LAYOUT };
  const explicit = new Set<LayoutKey>();
  const links: StoreLink[] = [];
  let project: StoreLayout["project"] = null;

  if (text !== null) {
    const fail = (why: string): never => {
      throw new LayoutError(`${file}: ${why}`);
    };
    let decl: unknown;
    try {
      decl = JSON.parse(text);
    } catch (e) {
      fail(`not valid JSON (${(e as Error).message})`);
    }
    if (typeof decl !== "object" || decl === null || Array.isArray(decl)) {
      fail("must be a JSON object");
    }
    const {
      layout,
      links: rawLinks,
      project: rawProject,
    } = decl as { layout?: unknown; links?: unknown; project?: unknown };

    try {
      if (layout !== undefined) {
        if (typeof layout !== "object" || layout === null || Array.isArray(layout)) {
          fail('"layout" must be an object');
        }
        for (const [key, value] of Object.entries(layout as Record<string, unknown>)) {
          if (!(LAYOUT_KEYS as string[]).includes(key)) {
            fail(`unknown key "layout.${key}" (known: ${LAYOUT_KEYS.join(", ")})`);
          }
          rel[key as LayoutKey] = storeRelative(value, `"layout.${key}"`);
          explicit.add(key as LayoutKey);
        }
      }

      if (rawLinks !== undefined) {
        if (!Array.isArray(rawLinks)) fail('"links" must be an array');
        (rawLinks as unknown[]).forEach((entry, i) => {
          if (typeof entry !== "object" || entry === null) fail(`"links[${i}]" must be an object`);
          const { from, to } = entry as { from?: unknown; to?: unknown };
          const fromRel = storeRelative(from, `"links[${i}].from"`);
          links.push({
            fromRel,
            toRaw: to as string,
            from: path.join(root, ...fromRel.split("/")),
            to: homeTarget(to, `"links[${i}].to"`, home),
          });
        });
      }

      if (rawProject !== undefined) {
        const rel = storeRelative(rawProject, '"project"');
        project = { rel, abs: path.join(root, ...rel.split("/")) };
      }
    } catch (e) {
      if (e instanceof LayoutError && !e.message.startsWith(file)) {
        throw new LayoutError(`${file}: ${e.message}`);
      }
      throw e;
    }
  }

  const abs = Object.fromEntries(
    LAYOUT_KEYS.map((k) => [k, path.join(root, ...rel[k].split("/"))]),
  ) as Record<LayoutKey, string>;

  return { root, declared: text !== null, rel, explicit, abs, links, project };
}

const cache = new Map<string, StoreLayout>();

/**
 * readLayout, memoised per store root. Callers ask for a path per skill in a
 * loop, and the file does not change while a command runs.
 */
export function layoutOf(root: string): StoreLayout {
  const key = path.resolve(root);
  let hit = cache.get(key);
  if (hit === undefined) {
    hit = readLayout(key);
    cache.set(key, hit);
  }
  return hit;
}
