/**
 * Read-only health check of the whole chain:
 *   store/skills  <- ~/.agents/skills  <- ~/.claude/skills/<name>, ~/.codex/skills/<name>, ...
 * Exits non-zero if anything is broken.
 *
 *   node scripts/run.js doctor          the whole chain, on the configured store
 *   node scripts/run.js doctor --repo   store contents only, on the invoking repo
 *
 * `--repo` is what the pre-commit hook runs. Two differences, both deliberate:
 *
 *   - It checks the repo it was invoked in, like `audit` does, instead of the
 *     store this machine has configured. Commits are often made from a worktree
 *     of the store, which is not the checkout config points at.
 *   - It checks only what that repo contains — lockfile, catalog, skill bodies.
 *     The `$HOME` wiring (symlinks, per-agent fan-out) and the surface report say
 *     nothing about whether a commit is sound, and a broken symlink is no reason
 *     to refuse one. Those stay in the full run.
 */
import fs from "node:fs";
import path from "node:path";
import {
  AGENT_SKILL_DIRS,
  HOOKS_DIR_NAME,
  HOOK_TEMPLATE,
  SKILL_KINDS,
  type Catalog,
  gitHooksPath,
  gitToplevel,
  hookDrift,
  inspectLink,
  links,
  presentSkillNames,
  readCatalog,
  readLock,
  storeCatalog,
  storeLock,
  storeSkills,
  thirdPartyNames,
  tilde,
} from "./lib/paths.ts";
import { CONFIG_PATH, STORE_ENV, overrideStore, resolveStoreOrNull } from "./lib/store.ts";

const repoMode = process.argv.includes("--repo");

let problems = 0;

/** True when `p` is `dir` itself or sits beneath it. */
const isInside = (p: string, dir: string): boolean => {
  const rel = path.relative(path.resolve(dir), p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** A skill is only discoverable by agents if it has a SKILL.md at its root. */
const hasSkillMd = (name: string): boolean =>
  fs.existsSync(path.join(storeSkills(), name, "SKILL.md"));

const ok = (m: string): void => console.log(`  ok    ${m}`);
const warn = (m: string): void => console.log(`  warn  ${m}`);
const bad = (m: string): void => {
  problems++;
  console.log(`  BAD   ${m}`);
};

/**
 * Where is the store, and is it usable? Everything downstream reads from it, so
 * an unconfigured or missing store is reported here and the rest is skipped.
 * Returns the store root, or null when nothing usable is configured.
 */
function checkStore(): string | null {
  console.log("store");
  const store = resolveStoreOrNull();
  if (store === null) {
    bad(
      `no store configured (${tilde(CONFIG_PATH)} / ${STORE_ENV} unset) — ` +
        "run `agent-skills init <dir>` or `agent-skills link <dir>`",
    );
    console.log("");
    return null;
  }
  const via = process.env[STORE_ENV] ? `${STORE_ENV}` : tilde(CONFIG_PATH);
  if (!fs.existsSync(store)) {
    bad(`${tilde(store)} does not exist (from ${via})`);
    console.log("");
    return null;
  }
  ok(`${tilde(store)} (from ${via})`);
  if (!fs.existsSync(path.join(store, ".git"))) {
    warn(`${tilde(store)} is not a git repo — \`git init\` there so history/hook work`);
  }
  console.log("");
  return store;
}

/**
 * The pre-commit audit only runs where the store's core.hooksPath points at
 * hooks/. That is repo-local config, so a fresh clone starts unprotected until
 * `agent-skills link`.
 *
 * Presence is not enough: the hook is a *copy* of the tool's template taken at
 * link time, and nothing re-copies it. A store linked before the template
 * changed silently keeps running the old hook, so the contents are compared too.
 */
function checkHooks(store: string): void {
  console.log("hooks");
  const current = gitHooksPath(store);
  const hook = path.join(store, HOOKS_DIR_NAME, "pre-commit");

  if (current === null) {
    bad(`core.hooksPath unset — pre-commit audit is NOT running. Run \`agent-skills link\``);
  } else if (current !== HOOKS_DIR_NAME) {
    bad(`core.hooksPath is ${current}, not ${HOOKS_DIR_NAME}/ — audit is NOT running`);
  } else if (!fs.existsSync(hook)) {
    bad(`${HOOKS_DIR_NAME}/pre-commit is missing — run \`agent-skills link\``);
  } else {
    // Both facts are worth reporting, so neither short-circuits the other: an
    // outdated hook and a non-executable one have different fixes.
    let executable = true;
    try {
      fs.accessSync(hook, fs.constants.X_OK);
    } catch {
      executable = false;
      bad(`${HOOKS_DIR_NAME}/pre-commit is not executable — \`chmod +x ${tilde(hook)}\``);
    }

    switch (hookDrift(hook)) {
      case "drifted":
        bad(
          `${HOOKS_DIR_NAME}/pre-commit differs from the tool's template ` +
            `(${tilde(HOOK_TEMPLATE)}) — run \`agent-skills link\` to reinstall it`,
        );
        break;
      case "unreadable":
        bad(
          `cannot read ${tilde(hook)} or ${tilde(HOOK_TEMPLATE)} to compare them — ` +
            "check permissions, then run `agent-skills link`",
        );
        break;
      case "matches":
        if (executable) {
          ok(`pre-commit audit active (core.hooksPath=${HOOKS_DIR_NAME}/), matches the tool's template`);
        }
        break;
    }
  }
  console.log("");
}

function checkLinks(): void {
  console.log("links (owned by the tool)");
  for (const { label, from, to } of links()) {
    const state = inspectLink(from, to);
    switch (state.kind) {
      case "linked-correctly":
        ok(`${label}: ${tilde(from)} -> ${tilde(to)}`);
        break;
      case "missing":
        bad(`${label}: ${tilde(from)} does not exist — run \`agent-skills link\``);
        break;
      case "linked-elsewhere":
        bad(`${label}: ${tilde(from)} -> ${tilde(state.target)} (not the configured store)`);
        break;
      case "real-dir":
      case "real-file":
        bad(`${label}: ${tilde(from)} is a real ${state.kind === "real-dir" ? "directory" : "file"}, not a symlink — run \`agent-skills link\``);
        break;
    }
  }
  console.log("");
}

function checkLock(): string[] {
  console.log("lockfile");
  let tracked: string[] = [];
  try {
    const lock = readLock();
    if (lock === null) {
      warn(`${tilde(storeLock())} not present yet`);
    } else {
      tracked = thirdPartyNames(lock);
      ok(`${tilde(storeLock())} parsed, ${tracked.length} 3rd-party skill(s)`);
    }
  } catch (e) {
    bad(`${tilde(storeLock())} is not valid JSON: ${(e as Error).message}`);
  }
  console.log("");
  return tracked;
}

function checkCatalog(): Catalog | null {
  console.log("catalog");
  let catalog: Catalog | null = null;
  try {
    catalog = readCatalog();
    if (catalog === null) {
      warn(`${tilde(storeCatalog())} not present — no provenance recorded for any skill`);
    } else {
      const entries = Object.entries(catalog.skills ?? {});
      ok(`${tilde(storeCatalog())} parsed, ${entries.length} skill(s) catalogued`);
      for (const [name, e] of entries) {
        if (!SKILL_KINDS.includes(e.kind)) {
          bad(`${name}: unknown kind ${JSON.stringify(e.kind)} — expected ${SKILL_KINDS.join(" | ")}`);
        }
        // A vendored skill has no URL anyone can follow, so prose provenance is
        // the only record of where the body came from.
        if (e.kind === "vendored" && (e.origin ?? "").trim() === "") {
          bad(`${name} (vendored) has no \`origin\` — provenance is the whole point`);
        }
      }
    }
  } catch (e) {
    bad(`${tilde(storeCatalog())} is not valid JSON: ${(e as Error).message}`);
  }
  console.log("");
  return catalog;
}

/**
 * Report every skill the same way — name, kind, author — whoever wrote it.
 * The kind only changes what a *missing* skill is told to do about it.
 */
function checkSkills(tracked: string[], catalog: Catalog | null): void {
  console.log("skills");
  const present = presentSkillNames();
  const presentSet = new Set(present);
  const trackedSet = new Set(tracked);
  const entries = catalog?.skills ?? {};

  for (const name of [...new Set([...Object.keys(entries), ...present])].sort()) {
    const entry = entries[name];
    const inLock = trackedSet.has(name);
    // Uncatalogued skills are still checked; the lockfile implies their kind.
    const kind = entry?.kind ?? (inLock ? "remote" : "own");
    const author = entry?.author !== undefined ? `, ${entry.author}` : "";
    const label = `${name} (${kind}${author})`;

    // kind and lockfile membership must agree, or gitignore says one thing and
    // the catalog another.
    if (entry !== undefined && (entry.kind === "remote") !== inLock) {
      bad(
        entry.kind === "remote"
          ? `${name}: kind "remote" but absent from skills.lock — nothing can fetch it`
          : `${name}: kind "${entry.kind}" but present in skills.lock — it would be gitignored`,
      );
      continue;
    }

    if (!presentSet.has(name)) {
      // A remote body is gitignored, so its absence says nothing about whether
      // this tree describes itself correctly — only that nobody has synced here
      // yet. A fresh worktree is exactly that, and it is where commits are made,
      // so blocking on it would make the hook unusable. Own and vendored bodies
      // are git-backed: missing means the commit really would drop them.
      const localOnly = repoMode && kind === "remote";
      (localOnly ? warn : bad)(
        kind === "remote"
          ? `${label} missing — run \`agent-skills sync\`${localOnly ? " (gitignored, so not a commit problem)" : ""}`
          : `${label} missing — \`git checkout -- skills/${name}\``,
      );
    } else if (!hasSkillMd(name)) {
      warn(`${label} has no SKILL.md — agents will ignore it`);
    } else if (entry === undefined) {
      // The catalog is the record of where a skill came from and how it gets
      // updated. A body with no entry has neither, so the store is no longer a
      // single source of truth about itself — that is a failure, not a note.
      bad(`${label} not in catalog.json — record its kind / author / refs there`);
    } else {
      ok(label);
    }
  }

  if (present.length === 0) warn(`${tilde(storeSkills())} is empty`);
  console.log("");
}

/**
 * Per-agent fan-out is written by `npx skills`; we only report on it.
 *
 * `expected` is every skill that ought to be reachable from a non-universal
 * agent. Own and vendored skills get their link by hand (see README), so
 * forgetting one is easy — and the symptom is silence: the skill sits in the
 * store, doctor used to pass, and the agent simply never sees it.
 */
function checkFanOut(expected: string[]): void {
  console.log("agent fan-out (written by `npx skills`)");
  const skillsDir = storeSkills();
  for (const { agent, dir, universal } of AGENT_SKILL_DIRS) {
    // Universal agents read the canonical store directly, so an empty or
    // absent per-agent dir is the expected, healthy state.
    if (universal) {
      ok(`${agent}: reads ~/.agents/skills directly (universal)`);
      continue;
    }
    if (!fs.existsSync(dir)) {
      warn(`${agent}: ${tilde(dir)} not present`);
      continue;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith("."));
    if (entries.length === 0) {
      warn(`${agent}: ${tilde(dir)} is empty`);
      continue;
    }

    const linked = new Set(entries.map((e) => e.name));
    for (const name of expected) {
      if (linked.has(name)) continue;
      bad(
        `${agent}: ${name} is in the store but not in ${tilde(dir)} — ` +
          `\`ln -s ../../.agents/skills/${name} ${tilde(path.join(dir, name))}\``,
      );
    }

    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (!fs.existsSync(p)) {
        bad(`${agent}: ${tilde(p)} is a broken link`);
        continue;
      }
      const real = fs.realpathSync(p);
      // Compare on a path boundary: a bare prefix test would also accept a
      // sibling like <store>/skills-old/, which is not this store.
      if (isInside(real, skillsDir)) {
        ok(`${agent}: ${e.name} -> the store`);
      } else if (e.isSymbolicLink()) {
        bad(`${agent}: ${e.name} -> ${tilde(real)} (outside the store — migrate it into ${tilde(skillsDir)})`);
      } else {
        // Agents ship their own built-in skills; those are not ours to manage.
        warn(`${agent}: ${e.name} is a real directory (not managed by this store)`);
      }
    }
  }
  console.log("");
}

/**
 * Skills do not sync across surfaces, so "the store is wired up" only ever
 * means the local filesystem one. Report the others so a green doctor is not
 * read as "everything, everywhere is current".
 */
function checkSurfaces(): void {
  console.log("surfaces (skills do NOT sync between these)");
  ok("local Claude Code (cli / desktop / ide): ~/.claude/skills -> the store (checked above)");
  if (process.env.ANTHROPIC_API_KEY !== undefined && process.env.ANTHROPIC_API_KEY.trim() !== "") {
    ok("api workspace: ANTHROPIC_API_KEY set — `agent-skills push` can upload");
  } else {
    // Not a failure: plenty of setups never touch the API surface.
    warn("api workspace: ANTHROPIC_API_KEY unset — `agent-skills push` cannot upload");
  }
  // Cloud sessions and Cowork run on Anthropic's machines, so the store on this
  // one is invisible to them however well it is linked. Their remedies differ,
  // so they are reported apart: a cloud session picks up what the cloned repo
  // declares, while Cowork only ever loads the claude.ai account's skills.
  // https://code.claude.com/docs/en/skills#skills-in-cowork-and-cloud-sessions
  warn("cloud sessions (claude.ai/code, routines): never read ~/.claude/skills — commit to the repo's .claude/skills, or declare a plugin in the repo's .claude/settings.json");
  warn("cowork: never reads ~/.claude/skills, and repo-declared plugins do not apply — it loads the skills enabled for your claude.ai account");
  warn("claude.ai: manual only — no API exists; upload from the web UI by hand");
  console.log("");
}

/** Shared tail: report the count and set the exit status. */
function summarise(): void {
  if (problems > 0) {
    console.log(`${problems} problem(s) found.`);
    process.exitCode = 1;
  } else {
    console.log("All checks passed.");
  }
}

/**
 * The pre-commit half: is this repo internally consistent?
 *
 * Note this reads the working tree, not the index — unlike `audit`, which scans
 * staged content. A store is a directory of skill bodies plus two files
 * describing them, and a half-staged store is already a store someone has to
 * fix; blocking on the tree they are actually looking at is the useful report.
 */
function repoMain(): void {
  const top = gitToplevel();
  if (top === null) {
    console.error("doctor --repo: not inside a git repo (this mode is for the pre-commit hook)");
    process.exitCode = 1;
    return;
  }
  overrideStore(top);
  console.log(`doctor --repo: ${tilde(top)}\n`);

  const tracked = checkLock();
  const catalog = checkCatalog();
  checkSkills(tracked, catalog);
  summarise();
}

function main(): void {
  if (repoMode) {
    repoMain();
    return;
  }

  const store = checkStore();
  if (store === null) {
    console.log(`${problems} problem(s) found.`);
    process.exitCode = 1;
    return;
  }
  checkLinks();
  checkHooks(store);
  const tracked = checkLock();
  const catalog = checkCatalog();
  checkSkills(tracked, catalog);
  // Only loadable skills are expected downstream — one without a SKILL.md is
  // already reported above, and linking it would not help.
  checkFanOut(presentSkillNames().filter(hasSkillMd));
  checkSurfaces();
  summarise();
}

main();
