import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { resolveStore } from "./store.ts";
import { type StoreLayout, layoutOf } from "./layout.ts";

/**
 * This CLI's own root, resolved from this file's location (scripts/lib/ -> ../..).
 *
 * The tool and the store are separate repos. CLI_ROOT locates code and templates
 * shipped with the tool (e.g. hooks/pre-commit); it says nothing about where the
 * skills live. Store paths come from store.ts (env / config), never from here.
 */
export const CLI_ROOT: string = path.resolve(import.meta.dirname, "..", "..");

/** Template pre-commit hook shipped by the tool, installed into a store on link. */
export const HOOK_TEMPLATE: string = path.join(CLI_ROOT, "hooks", "pre-commit");

/** The configured store repo. Throws (with the fix) when nothing is configured. */
export function storeRoot(): string {
  return resolveStore();
}

/**
 * The configured store's layout: its `agent-skills.json`, or the defaults when
 * it has none. Throws (actionable) when the declaration is malformed — every
 * path below goes through here, so no command runs on a layout it cannot trust.
 */
export function storeLayout(): StoreLayout {
  return layoutOf(storeRoot());
}

/** Canonical store inside the store repo. `~/.agents/skills` is symlinked here. */
export function storeSkills(): string {
  return storeLayout().abs.skills;
}

/** Canonical lockfile inside the store repo. `~/.agents/.skill-lock.json` -> here. */
export function storeLock(): string {
  return storeLayout().abs.lock;
}

/**
 * The global instruction file, read by every agent in every session.
 *
 * Not a skill, and deliberately not under `skills/`: a skill loads on demand
 * when its description matches, while this is unconditional context. It lives
 * in the store anyway so the pre-commit audit covers it — of everything here,
 * this is the file a leaked secret would reach the furthest from.
 */
export function storeAgentsMd(): string {
  return storeLayout().abs.agentsMd;
}

/**
 * Provenance for *every* skill, own or 3rd-party: author, reference URLs, how it
 * got here. Owned by the store repo alone — `npx skills` never reads or writes it.
 *
 * Separate from skills.lock, which answers a different question (how to re-fetch)
 * and only covers remote skills. Metadata is uniform across all three kinds;
 * restore is not.
 */
export function storeCatalog(): string {
  return storeLayout().abs.catalog;
}

/**
 * Hooks live in the store repo, not .git/hooks, so they are version-controlled
 * and reach every clone. `core.hooksPath` is what makes git look there.
 */
export const HOOKS_DIR_NAME = "hooks";

/**
 * Toplevel of the git repo containing `cwd`, or null when there is none.
 *
 * Used by the commands that must act on *the repo they were invoked in* rather
 * than the configured store — `audit` and `doctor --repo`, both of which run as
 * pre-commit hooks. Note this resolves a worktree to the worktree's own root,
 * which is what a hook wants: that is the tree being committed.
 */
export function gitToplevel(cwd: string = process.cwd()): string | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  const top = (r.stdout ?? "").trim();
  return r.status === 0 && top !== "" ? top : null;
}

/**
 * Files git currently tracks under any of `paths`, repo-relative. Null when the
 * query could not run at all (no git, not a repo) — which is not the same
 * answer as "nothing is tracked", and callers must not conflate them.
 *
 * `-z` for the same reason `audit` needs it: without it `core.quotePath` prints
 * a non-ASCII path octal-escaped, and a skill named in Japanese would silently
 * drop out of the result.
 */
export function gitTrackedUnder(cwd: string, paths: string[]): string[] | null {
  if (paths.length === 0) return [];
  const r = spawnSync("git", ["ls-files", "-z", "--", ...paths], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").split("\0").filter((s) => s !== "");
}

/** Current `core.hooksPath` for the repo at `cwd`, or null when unset. Read-only. */
export function gitHooksPath(cwd: string): string | null {
  const r = spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd, encoding: "utf8" });
  const v = (r.stdout ?? "").trim();
  return r.status === 0 && v !== "" ? v : null;
}

/**
 * Whether a store's installed hook still matches the template it came from.
 *
 * `link` copies HOOK_TEMPLATE into the store once; nothing re-copies it. So a
 * store linked before the tool changed its template keeps running the old hook
 * forever, and its existence check keeps passing — which is why `doctor`
 * compares contents rather than just presence.
 */
export type HookDrift = "matches" | "drifted" | "unreadable";

export function hookDrift(installed: string, template: string = HOOK_TEMPLATE): HookDrift {
  try {
    // Byte-for-byte: the template is the only supported content, so any edit is
    // drift. Hand-customising the hook is not a use case `link` preserves.
    return fs.readFileSync(installed, "utf8") === fs.readFileSync(template, "utf8")
      ? "matches"
      : "drifted";
  } catch {
    return "unreadable";
  }
}

export const HOME: string = homedir();
export const AGENTS_DIR: string = path.join(HOME, ".agents");
export const AGENTS_SKILLS: string = path.join(AGENTS_DIR, "skills");
export const AGENTS_LOCK: string = path.join(AGENTS_DIR, ".skill-lock.json");
export const AGENTS_MD: string = path.join(AGENTS_DIR, "AGENTS.md");

/**
 * The three links the tool owns, pointing `~/.agents` at the configured store.
 * The per-agent fan-out below it (~/.claude/skills, ~/.codex/skills, ...) is
 * owned by lib/agents.ts + lib/fanout.ts — see `agent-skills agents`.
 *
 * `agents.md` is the hub link only. Pointing each agent's own instruction file
 * at it (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, …) is not done here: the
 * filename differs per agent, and writing into an agent's dir uninvited is the
 * thing lib/agents.ts exists to prevent. Link those by hand, or opt in later.
 */
export function links(): ReadonlyArray<{ label: string; from: string; to: string }> {
  return [
    { label: "skills", from: AGENTS_SKILLS, to: storeSkills() },
    { label: "lock", from: AGENTS_LOCK, to: storeLock() },
    { label: "agents.md", from: AGENTS_MD, to: storeAgentsMd() },
  ];
}

export type LinkState =
  | { kind: "missing" }
  | { kind: "linked-correctly"; target: string }
  | { kind: "linked-elsewhere"; target: string }
  | { kind: "real-dir" }
  | { kind: "real-file" };

/**
 * Classify what currently sits at `from`. Uses lstat so a symlink is never
 * followed — we need to know about the link itself, not what it points at.
 */
export function inspectLink(from: string, expectedTo: string): LinkState {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(from);
  } catch {
    return { kind: "missing" };
  }

  if (st.isSymbolicLink()) {
    const raw = fs.readlinkSync(from);
    const target = path.resolve(path.dirname(from), raw);
    return target === path.resolve(expectedTo)
      ? { kind: "linked-correctly", target }
      : { kind: "linked-elsewhere", target };
  }

  return st.isDirectory() ? { kind: "real-dir" } : { kind: "real-file" };
}

export type LockEntry = {
  source: string;
  sourceType: string;
  sourceUrl?: string;
  skillPath?: string;
  skillFolderHash?: string;
};

export type Lock = {
  version?: number;
  skills?: Record<string, LockEntry>;
  lastSelectedAgents?: string[];
  [k: string]: unknown;
};

/**
 * Agents to install to, from the lockfile's own record of the user's choice.
 *
 * This must resolve to at least two agents with *distinct* skills dirs. The
 * `skills` CLI picks its install mode like this (dist/cli.mjs):
 *
 *   const uniqueDirs = new Set(targetAgents.map(a => agents[a].skillsDir));
 *   ...
 *   else if (uniqueDirs.size <= 1) installMode = "copy";
 *
 * With one agent it copies the skill body straight into that agent's dir,
 * bypassing the canonical `~/.agents/skills` store. Two or more dirs keep it in
 * symlink mode, so the body lands in the store and agents get links.
 */
export const FALLBACK_AGENTS: ReadonlyArray<string> = ["claude-code", "codex"];

export function targetAgents(lock: Lock | null): string[] {
  const selected = lock?.lastSelectedAgents ?? [];
  return selected.length >= 2 ? selected : [...FALLBACK_AGENTS];
}

/** Read the lockfile. Returns null when absent; throws on malformed JSON. */
export function readLock(file: string = storeLock()): Lock | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return JSON.parse(text) as Lock;
}

/** Names of 3rd-party skills, i.e. everything the lockfile tracks. */
export function thirdPartyNames(lock: Lock | null): string[] {
  return Object.keys(lock?.skills ?? {}).sort();
}

/**
 * How a skill got here, and therefore how it comes back on a fresh machine.
 *
 *   own      — written here. Committed; restored by git.
 *   remote   — fetched from a git host. Gitignored; restored by `agent-skills sync`.
 *   vendored — 3rd-party with no remote (a zip, an internal share, a dead repo).
 *              Committed like an own skill, because nothing can re-fetch it.
 *
 * Only `remote` appears in skills.lock. The other two have no fetch step, which
 * is exactly why they must live in git.
 */
export type SkillKind = "own" | "remote" | "vendored";

export const SKILL_KINDS: ReadonlyArray<SkillKind> = ["own", "remote", "vendored"];

export type CatalogEntry = {
  kind: SkillKind;
  /** Person or org that wrote it. For `own` skills, you. */
  author?: string;
  /** Anything worth reading later: the note article it came from, docs, an issue. */
  refs?: string[];
  /** Required for `vendored`: where the body came from, in prose. */
  origin?: string;
  /** License, who to ask about updates, caveats. */
  note?: string;
  /** ISO date this skill entered the repo. */
  addedAt?: string;
};

export type Catalog = {
  version?: number;
  skills?: Record<string, CatalogEntry>;
};

/** Read catalog.json. Returns null when absent; throws on malformed JSON. */
export function readCatalog(file: string = storeCatalog()): Catalog | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return JSON.parse(text) as Catalog;
}

/** Every catalogued name, regardless of kind. */
export function catalogNames(catalog: Catalog | null): string[] {
  return Object.keys(catalog?.skills ?? {}).sort();
}

/** Catalogued names of one kind. */
export function namesOfKind(catalog: Catalog | null, kind: SkillKind): string[] {
  return Object.entries(catalog?.skills ?? {})
    .filter(([, e]) => e.kind === kind)
    .map(([name]) => name)
    .sort();
}

/**
 * Names that must stay out of git: exactly the ones `agent-skills sync` can
 * re-fetch.
 *
 * Derived from skills.lock rather than the catalog on purpose. The lockfile is
 * written by the CLI and is always true; the catalog is hand-edited and can
 * drift. Ignoring a skill git is the only copy of would lose it, so the safer
 * source wins — `doctor` reports drift between the two instead.
 */
export function ignorableNames(lock: Lock | null): string[] {
  return thirdPartyNames(lock);
}

/** Directory names actually present in the store's skills/ dir. */
export function presentSkillNames(dir: string = storeSkills()): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/**
 * Top-level scalar fields of a SKILL.md YAML frontmatter block.
 *
 * Deliberately not a YAML parser: skill frontmatter is a handful of `key: value`
 * lines, and pulling in a dependency for that would break the "Node and nothing
 * else" requirement. Nested structures and multi-line values are not read.
 */
export function frontmatter(text: string): Record<string, string> {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (fm === null) return {};
  const out: Record<string, string> = {};
  for (const line of (fm[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (kv === null) continue;
    out[kv[1]!] = (kv[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Why a single-line YAML scalar would not mean what it looks like, or null.
 *
 * Plain (unquoted) scalars are where hand-written frontmatter breaks: `: `
 * inside one is a syntax error, ` #` silently truncates it, and a leading
 * indicator turns it into something other than a string. Quoted scalars only
 * need to be closed.
 */
function scalarProblem(value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  if (v.startsWith("'")) {
    return /^'(?:[^']|'')*'\s*(?:#.*)?$/.test(v) ? null : "single quote is not closed (write '' for a literal ')";
  }
  if (v.startsWith('"')) {
    return /^"(?:[^"\\]|\\.)*"\s*(?:#.*)?$/.test(v) ? null : "double quote is not closed";
  }
  if (/^[[\]{},#&*!|>%@`]/.test(v) || /^[-?:](?:\s|$)/.test(v)) {
    return `starts with \`${v[0]}\`, which YAML reads as syntax — quote the value`;
  }
  if (/:(?:\s|$)/.test(v)) return "contains `: ` — quote the value";
  if (/\s#/.test(v)) return "` #` starts a comment and cuts the value short — quote the value";
  return null;
}

/**
 * Places where a SKILL.md frontmatter block is not valid YAML, as
 * `line N: reason` strings (N counts from the opening `---`). Empty when sound.
 *
 * {@link frontmatter} reads leniently, and so does Claude Code, so a skill with
 * broken YAML works here. Strict parsers (claude.ai upload, the Skills API,
 * `skills-ref validate`, and other agents the store fans out to) reject it or
 * read a different value. Still not a YAML parser: it covers the shapes skill
 * frontmatter actually uses — top-level `key: value`, block scalars, plain
 * continuation lines, and one level of nested `key: value` / `- item`.
 */
export function frontmatterProblems(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return ["line 1: frontmatter must open with `---`"];
  const end = lines.indexOf("---", 1);
  if (end === -1) return ["frontmatter is never closed with `---`"];

  const problems: string[] = [];
  const seen = new Set<string>();
  // What indented lines after the current top-level key are.
  let follow: "none" | "block" | "nested" | "continuation" = "none";
  let quoted = "";
  let quotedAt = 0;

  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    const at = `line ${i + 1}`;
    if (/^\s*(?:#.*)?$/.test(line)) continue;

    if (/^\s/.test(line)) {
      if (follow === "block") continue;
      if (follow === "continuation") {
        if (quoted !== "") quoted += ` ${line.trim()}`;
        else {
          const p = scalarProblem(line.trim());
          if (p !== null) problems.push(`${at}: ${p}`);
        }
        continue;
      }
      if (follow === "nested") {
        const kv = /^\s+(?:-\s+(.*)|-$|[A-Za-z0-9][\w.-]*:(?:\s+(.*))?$)/.exec(line);
        if (kv === null) {
          problems.push(`${at}: expected \`key: value\` or \`- item\` under the key above`);
          continue;
        }
        const p = scalarProblem(kv[1] ?? kv[2] ?? "");
        if (p !== null) problems.push(`${at}: ${p}`);
        continue;
      }
      problems.push(`${at}: indented, but the key above already has a value on its line`);
      continue;
    }

    if (quoted !== "") {
      const p = scalarProblem(quoted);
      if (p !== null) problems.push(`line ${quotedAt}: ${p}`);
      quoted = "";
    }

    const kv = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (kv === null) {
      problems.push(`${at}: not \`key: value\``);
      follow = "none";
      continue;
    }
    const [, key, raw = ""] = kv;
    if (seen.has(key!)) problems.push(`${at}: \`${key}\` appears twice`);
    seen.add(key!);

    const value = raw.trim();
    if (value === "") {
      follow = "nested";
    } else if (/^[|>][-+0-9]*\s*(?:#.*)?$/.test(value)) {
      follow = "block";
    } else {
      follow = "continuation";
      const opens = value[0] === "'" || value[0] === '"';
      if (opens && scalarProblem(value) !== null) {
        // A quoted scalar may span lines; judge it once it has all of them.
        quoted = value;
        quotedAt = i + 1;
      } else if (opens) {
        // Closed on its own line: nothing may continue it.
        follow = "none";
      } else {
        const p = scalarProblem(value);
        if (p !== null) problems.push(`${at}: ${p}`);
      }
    }
  }
  if (quoted !== "") {
    const p = scalarProblem(quoted);
    if (p !== null) problems.push(`line ${quotedAt}: ${p}`);
  }
  return problems;
}

/** Render an absolute path with `~` for readable output. */
export function tilde(p: string): string {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}
