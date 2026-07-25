/**
 * Reconcile the repo with skills.lock and catalog.json:
 *   1. re-fetch any remote skill the lockfile tracks but that is missing on disk
 *   2. regenerate skills/.gitignore so lockfile entries stay out of git
 *   3. report catalogued skills git should have restored (own / vendored)
 *
 * Fetching is delegated to `npx skills` — this repo deliberately does not
 * reimplement acquisition or the per-agent fan-out.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  catalogNames,
  ignorableNames,
  namesOfKind,
  presentSkillNames,
  readCatalog,
  readLock,
  storeCatalog,
  storeSkills,
  targetAgents,
  thirdPartyNames,
  tilde,
} from "./lib/paths.ts";

const gitignorePath = (): string => path.join(storeSkills(), ".gitignore");
const BEGIN = "# --- managed by scripts/sync.ts (do not edit) ---";
const END = "# --- end managed ---";

const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");

/**
 * Rewrite only the managed block, preserving anything a human added around it.
 */
function writeGitignore(names: string[]): void {
  const GITIGNORE = gitignorePath();
  const block = [
    BEGIN,
    "# 3rd-party skills: tracked in ../skills.lock, restored by `agent-skills sync`.",
    ...names.map((n) => `/${n}/`),
    END,
  ].join("\n");

  let next: string;
  const existing = fs.existsSync(GITIGNORE) ? fs.readFileSync(GITIGNORE, "utf8") : "";
  const start = existing.indexOf(BEGIN);
  const stop = existing.indexOf(END);

  if (start !== -1 && stop !== -1 && stop > start) {
    next = existing.slice(0, start) + block + existing.slice(stop + END.length);
  } else {
    next = existing.trimEnd() === "" ? `${block}\n` : `${existing.trimEnd()}\n\n${block}\n`;
  }

  if (next === existing) {
    console.log(`gitignore: up to date (${names.length} entries)`);
    return;
  }
  if (dryRun) {
    console.log(`gitignore: would update ${tilde(GITIGNORE)} (${names.length} entries)`);
    return;
  }
  fs.writeFileSync(GITIGNORE, next);
  console.log(`gitignore: updated ${tilde(GITIGNORE)} (${names.length} entries)`);
}

function buildArgs(source: string, skill: string, agents: string[]): string[] {
  const args = ["skills", "add", source, "-g", "-y", "-s", skill];
  for (const a of agents) args.push("-a", a);
  return args;
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Run `skills add`, self-healing against a stale agent list.
 *
 * `lastSelectedAgents` is written by the CLI but drifts as upstream renames
 * agents (e.g. kimi-cli -> kimi-code-cli). One unknown name aborts the whole
 * install, so on that failure we intersect our list with the "Valid agents:"
 * line the CLI prints and retry once.
 */
function install(source: string, skill: string, agents: string[]): boolean {
  const run = (list: string[]) =>
    spawnSync("npx", buildArgs(source, skill, list), { encoding: "utf8" });

  let res = run(agents);
  let out = stripAnsi(`${res.stdout ?? ""}${res.stderr ?? ""}`);

  if (res.status !== 0 && out.includes("Invalid agents:")) {
    const valid = out.match(/Valid agents:\s*([^\n]+)/)?.[1];
    if (valid !== undefined) {
      const allowed = new Set(valid.split(",").map((s) => s.trim()));
      const kept = agents.filter((a) => allowed.has(a));
      const dropped = agents.filter((a) => !allowed.has(a));
      if (kept.length >= 2 && dropped.length > 0) {
        console.log(`    dropping unknown agent(s): ${dropped.join(", ")} — retrying`);
        res = run(kept);
        out = stripAnsi(`${res.stdout ?? ""}${res.stderr ?? ""}`);
      }
    }
  }

  if (res.status === 0) {
    const where = out.match(/✓\s*(\S+)/)?.[1];
    console.log(`    ok${where !== undefined ? ` -> ${where}` : ""}`);
    return true;
  }
  console.error(out.trim());
  console.error(`  ${skill}: \`npx skills add ${source}\` exited ${res.status}`);
  return false;
}

/**
 * `own` and `vendored` skills live in git, so sync has nothing to fetch — it
 * only reports. A missing one means the working tree lost it, not that a
 * download is due, so pointing at `agent-skills sync` would send you in a circle.
 */
function reportGitBacked(catalog: ReturnType<typeof readCatalog>, present: Set<string>): void {
  const gitBacked = [...namesOfKind(catalog, "own"), ...namesOfKind(catalog, "vendored")].sort();
  if (gitBacked.length === 0) return;

  const missing = gitBacked.filter((n) => !present.has(n));
  console.log(`catalog: ${gitBacked.length} git-backed skill(s) (own + vendored)`);
  if (missing.length === 0) {
    console.log("catalog: all present\n");
    return;
  }
  for (const name of missing) {
    console.error(`  ${name}: in ${tilde(storeCatalog())} but missing on disk`);
    console.error(`    nothing can re-fetch it — \`git checkout -- skills/${name}\``);
  }
  process.exitCode = 1;
  console.log("");
}

function main(): void {
  const lock = readLock();
  if (lock === null) {
    console.log("No skills.lock yet — nothing to sync.");
    return;
  }

  const catalog = readCatalog();
  const tracked = thirdPartyNames(lock);
  const present = new Set(presentSkillNames());
  const missing = tracked.filter((n) => !present.has(n));
  const agents = targetAgents(lock);

  // A skill the catalog calls git-backed but the lockfile can fetch would be
  // both committed and ignored. Refuse to write a gitignore under that doubt.
  const gitBacked = new Set([...namesOfKind(catalog, "own"), ...namesOfKind(catalog, "vendored")]);
  const conflicts = tracked.filter((n) => gitBacked.has(n));
  if (conflicts.length > 0) {
    console.error(`conflict: ${conflicts.join(", ")} in skills.lock but not kind "remote" in catalog.json`);
    console.error("  a skill is either fetchable (remote) or git-backed (own/vendored) — fix one");
    process.exitCode = 1;
    return;
  }

  console.log(`lock: ${tracked.length} remote skill(s) tracked`);

  if (missing.length === 0) {
    console.log("fetch: all present\n");
  } else {
    console.log(`fetch: ${missing.length} missing -> ${missing.join(", ")}`);
    console.log(`fetch: installing to ${agents.length} agents (${agents.slice(0, 4).join(", ")}…)\n`);
    for (const name of missing) {
      const source = lock.skills?.[name]?.source;
      if (source === undefined) {
        console.error(`  ${name}: no source in lockfile, skipping`);
        process.exitCode = 1;
        continue;
      }
      if (dryRun) {
        console.log(`  would: npx ${buildArgs(source, name, agents).join(" ")}`);
        continue;
      }
      console.log(`  npx skills add ${source} -s ${name}`);
      if (!install(source, name, agents)) process.exitCode = 1;
    }
    console.log("");
  }

  const nowPresent = new Set(presentSkillNames());
  reportGitBacked(catalog, nowPresent);

  // Only what sync can re-fetch gets ignored. Everything else is committed.
  writeGitignore(ignorableNames(lock));

  const uncatalogued = [...nowPresent].filter((n) => !catalogNames(catalog).includes(n)).sort();
  if (uncatalogued.length > 0) {
    console.log(`\nnot in catalog.json: ${uncatalogued.join(", ")}`);
    console.log("  add an entry so author / refs are recorded — `agent-skills doctor` lists them");
  }
}

main();
