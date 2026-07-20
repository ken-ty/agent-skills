/**
 * Read-only health check of the whole chain:
 *   repo/skills  <- ~/.agents/skills  <- ~/.claude/skills/<name>, ~/.codex/skills/<name>, ...
 * Exits non-zero if anything is broken.
 */
import fs from "node:fs";
import path from "node:path";
import {
  AGENT_SKILL_DIRS,
  HOOKS_DIR_NAME,
  LINKS,
  REPO_CATALOG,
  REPO_LOCK,
  REPO_ROOT,
  REPO_SKILLS,
  SKILL_KINDS,
  type Catalog,
  gitHooksPath,
  inspectLink,
  presentSkillNames,
  readCatalog,
  readLock,
  thirdPartyNames,
  tilde,
} from "./lib/paths.ts";

let problems = 0;

/** True when `p` is `dir` itself or sits beneath it. */
const isInside = (p: string, dir: string): boolean => {
  const rel = path.relative(path.resolve(dir), p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** A skill is only discoverable by agents if it has a SKILL.md at its root. */
const hasSkillMd = (name: string): boolean =>
  fs.existsSync(path.join(REPO_SKILLS, name, "SKILL.md"));

const ok = (m: string): void => console.log(`  ok    ${m}`);
const warn = (m: string): void => console.log(`  warn  ${m}`);
const bad = (m: string): void => {
  problems++;
  console.log(`  BAD   ${m}`);
};

/**
 * The pre-commit audit only runs where core.hooksPath points at hooks/. That is
 * repo-local config, so a fresh clone starts unprotected until `npm run link`.
 */
function checkHooks(): void {
  console.log("hooks");
  const current = gitHooksPath();
  const hook = path.join(REPO_ROOT, HOOKS_DIR_NAME, "pre-commit");

  if (current === null) {
    bad(`core.hooksPath unset — pre-commit audit is NOT running. Run \`npm run link\``);
  } else if (current !== HOOKS_DIR_NAME) {
    bad(`core.hooksPath is ${current}, not ${HOOKS_DIR_NAME}/ — audit is NOT running`);
  } else if (!fs.existsSync(hook)) {
    bad(`${HOOKS_DIR_NAME}/pre-commit is missing`);
  } else {
    try {
      fs.accessSync(hook, fs.constants.X_OK);
      ok(`pre-commit audit active (core.hooksPath=${HOOKS_DIR_NAME}/)`);
    } catch {
      bad(`${HOOKS_DIR_NAME}/pre-commit is not executable — \`chmod +x ${HOOKS_DIR_NAME}/pre-commit\``);
    }
  }
  console.log("");
}

function checkLinks(): void {
  console.log("links (owned by this repo)");
  for (const { label, from, to } of LINKS) {
    const state = inspectLink(from, to);
    switch (state.kind) {
      case "linked-correctly":
        ok(`${label}: ${tilde(from)} -> ${tilde(to)}`);
        break;
      case "missing":
        bad(`${label}: ${tilde(from)} does not exist — run \`npm run link\``);
        break;
      case "linked-elsewhere":
        bad(`${label}: ${tilde(from)} -> ${tilde(state.target)} (not this repo)`);
        break;
      case "real-dir":
      case "real-file":
        bad(`${label}: ${tilde(from)} is a real ${state.kind === "real-dir" ? "directory" : "file"}, not a symlink — run \`npm run link\``);
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
      warn(`${tilde(REPO_LOCK)} not present yet`);
    } else {
      tracked = thirdPartyNames(lock);
      ok(`${tilde(REPO_LOCK)} parsed, ${tracked.length} 3rd-party skill(s)`);
    }
  } catch (e) {
    bad(`${tilde(REPO_LOCK)} is not valid JSON: ${(e as Error).message}`);
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
      warn(`${tilde(REPO_CATALOG)} not present — no provenance recorded for any skill`);
    } else {
      const entries = Object.entries(catalog.skills ?? {});
      ok(`${tilde(REPO_CATALOG)} parsed, ${entries.length} skill(s) catalogued`);
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
    bad(`${tilde(REPO_CATALOG)} is not valid JSON: ${(e as Error).message}`);
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
      bad(
        kind === "remote"
          ? `${label} missing — run \`npm run sync\``
          : `${label} missing — \`git checkout -- skills/${name}\``,
      );
    } else if (!hasSkillMd(name)) {
      warn(`${label} has no SKILL.md — agents will ignore it`);
    } else if (entry === undefined) {
      warn(`${label} not in catalog.json — author / refs unrecorded`);
    } else {
      ok(label);
    }
  }

  if (present.length === 0) warn(`${tilde(REPO_SKILLS)} is empty`);
  console.log("");
}

/**
 * Per-agent fan-out is written by `npx skills`; we only report on it.
 *
 * `expected` is every skill that ought to be reachable from a non-universal
 * agent. Own and vendored skills get their link by hand (see README), so
 * forgetting one is easy — and the symptom is silence: the skill sits in the
 * repo, doctor used to pass, and the agent simply never sees it.
 */
function checkFanOut(expected: string[]): void {
  console.log("agent fan-out (written by `npx skills`)");
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
        `${agent}: ${name} is in the repo but not in ${tilde(dir)} — ` +
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
      // sibling like <repo>/skills-old/, which is not this store.
      if (isInside(real, REPO_SKILLS)) {
        ok(`${agent}: ${e.name} -> this repo`);
      } else if (e.isSymbolicLink()) {
        bad(`${agent}: ${e.name} -> ${tilde(real)} (outside this repo — migrate it into ${tilde(REPO_SKILLS)})`);
      } else {
        // Agents ship their own built-in skills; those are not ours to manage.
        warn(`${agent}: ${e.name} is a real directory (not managed by this repo)`);
      }
    }
  }
  console.log("");
}

function main(): void {
  console.log(`repo: ${REPO_ROOT}\n`);
  checkLinks();
  checkHooks();
  const tracked = checkLock();
  const catalog = checkCatalog();
  checkSkills(tracked, catalog);
  // Only loadable skills are expected downstream — one without a SKILL.md is
  // already reported above, and linking it would not help.
  checkFanOut(presentSkillNames().filter(hasSkillMd));

  if (problems > 0) {
    console.log(`${problems} problem(s) found.`);
    process.exitCode = 1;
  } else {
    console.log("All checks passed.");
  }
}

main();
