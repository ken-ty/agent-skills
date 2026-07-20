import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

/** Repo root, resolved from this file's location (scripts/lib/ -> ../..). */
export const REPO_ROOT: string = path.resolve(import.meta.dirname, "..", "..");

/** Canonical store inside the repo. `~/.agents/skills` is symlinked to this. */
export const REPO_SKILLS: string = path.join(REPO_ROOT, "skills");

/** Canonical lockfile inside the repo. `~/.agents/.skill-lock.json` is symlinked to this. */
export const REPO_LOCK: string = path.join(REPO_ROOT, "skills.lock");

/**
 * Provenance for *every* skill, own or 3rd-party: author, reference URLs, how
 * it got here. Owned by this repo alone — `npx skills` never reads or writes it.
 *
 * This is deliberately separate from skills.lock, which answers a different
 * question (how to re-fetch) and only covers remote skills. Metadata is uniform
 * across all three kinds; restore is not.
 */
export const REPO_CATALOG: string = path.join(REPO_ROOT, "catalog.json");

/**
 * Hooks live in the repo, not .git/hooks, so they are version-controlled and
 * reach every clone. `core.hooksPath` is what makes git look here.
 */
export const HOOKS_DIR_NAME = "hooks";

/** Current `core.hooksPath`, or null when unset. Read-only. */
export function gitHooksPath(cwd: string = REPO_ROOT): string | null {
  const r = spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd, encoding: "utf8" });
  const v = (r.stdout ?? "").trim();
  return r.status === 0 && v !== "" ? v : null;
}

export const HOME: string = homedir();
export const AGENTS_DIR: string = path.join(HOME, ".agents");
export const AGENTS_SKILLS: string = path.join(AGENTS_DIR, "skills");
export const AGENTS_LOCK: string = path.join(AGENTS_DIR, ".skill-lock.json");

/**
 * The two links this repo owns. Everything below `~/.agents` (the per-agent
 * fan-out into ~/.claude/skills, ~/.codex/skills, ...) is owned by `npx skills`.
 */
export const LINKS: ReadonlyArray<{ label: string; from: string; to: string }> = [
  { label: "skills", from: AGENTS_SKILLS, to: REPO_SKILLS },
  { label: "lock", from: AGENTS_LOCK, to: REPO_LOCK },
];

/**
 * Per-agent global skill dirs, mirroring the `skills` CLI agent registry.
 * Inspected read-only by doctor — this repo never writes here.
 *
 * `universal` agents declare `skillsDir: ".agents/skills"`, so the CLI installs
 * them straight into the canonical store (this repo) and their own dir stays
 * empty. Only non-universal agents get per-skill symlinks.
 */
export const AGENT_SKILL_DIRS: ReadonlyArray<{
  agent: string;
  dir: string;
  universal: boolean;
}> = [
  { agent: "claude-code", dir: path.join(HOME, ".claude", "skills"), universal: false },
  { agent: "codex", dir: path.join(HOME, ".codex", "skills"), universal: true },
  { agent: "gemini-cli", dir: path.join(HOME, ".gemini", "skills"), universal: true },
  { agent: "cursor", dir: path.join(HOME, ".cursor", "skills"), universal: true },
];

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
 * bypassing the canonical `~/.agents/skills` store — which is this repo. Two or
 * more dirs keep it in symlink mode, so the body lands here and agents get links.
 */
export const FALLBACK_AGENTS: ReadonlyArray<string> = ["claude-code", "codex"];

export function targetAgents(lock: Lock | null): string[] {
  const selected = lock?.lastSelectedAgents ?? [];
  return selected.length >= 2 ? selected : [...FALLBACK_AGENTS];
}

/** Read the lockfile. Returns null when absent; throws on malformed JSON. */
export function readLock(file: string = REPO_LOCK): Lock | null {
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
 *   remote   — fetched from a git host. Gitignored; restored by `npm run sync`.
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
export function readCatalog(file: string = REPO_CATALOG): Catalog | null {
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
 * Names that must stay out of git: exactly the ones `npm run sync` can re-fetch.
 *
 * Derived from skills.lock rather than the catalog on purpose. The lockfile is
 * written by the CLI and is always true; the catalog is hand-edited and can
 * drift. Ignoring a skill git is the only copy of would lose it, so the safer
 * source wins — `doctor` reports drift between the two instead.
 */
export function ignorableNames(lock: Lock | null): string[] {
  return thirdPartyNames(lock);
}

/** Directory names actually present in the repo's skills/ dir. */
export function presentSkillNames(dir: string = REPO_SKILLS): string[] {
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

/** Render an absolute path with `~` for readable output. */
export function tilde(p: string): string {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}
