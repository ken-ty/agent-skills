/**
 * Write the per-skill symlinks that let each agent see the store.
 *
 * The store is the truth; an agent dir is a view of it. This module makes the
 * view match, for the agents the user has enabled — see lib/agents.ts for how
 * that set is chosen, and why presence of a directory is not enough to join it.
 *
 * Only symlinks are ever created, repointed, or removed. A real directory in
 * the way is reported and left alone: it holds bytes this tool did not put
 * there (an agent's own bundled skill, or a copy-mode install), and deleting it
 * could be the only copy. Reporting is the whole remedy — `doctor` says the
 * same thing, and removing it is a decision for a human.
 */
import fs from "node:fs";
import path from "node:path";
import { AGENTS_MD, AGENTS_SKILLS, inspectLink, storeSkills, tilde } from "./paths.ts";
import { type AgentDef, distributionTargets, linkTarget } from "./agents.ts";
import { symlinkSync } from "./symlink.ts";

export type FanOutAction =
  | { kind: "linked"; agent: string; name: string; at: string }
  | { kind: "repointed"; agent: string; name: string; at: string; was: string }
  | { kind: "pruned"; agent: string; name: string; at: string }
  | { kind: "blocked"; agent: string; name: string; at: string; why: string };

export type FanOutReport = {
  targets: AgentDef[];
  actions: FanOutAction[];
  /** Links already correct. Counted, not listed — the healthy case is quiet. */
  alreadyCorrect: number;
};

/** True when `p` is `dir` itself or sits beneath it. */
function isInside(p: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * A link this tool owns: it points into `~/.agents/skills`, whether or not the
 * skill it names still exists. Used to decide what may be pruned — a link to
 * anywhere else was put there by something else and is not ours to remove.
 */
function pointsIntoStore(linkPath: string): boolean {
  let raw: string;
  try {
    raw = fs.readlinkSync(linkPath);
  } catch {
    return false;
  }
  return isInside(path.resolve(path.dirname(linkPath), raw), AGENTS_SKILLS);
}

/**
 * Reconcile every enabled agent dir against `names`.
 *
 * `dryRun` reports the identical action list without touching the filesystem,
 * so `--dry-run` output is exactly what a real run would do.
 */
export function reconcileFanOut(names: string[], dryRun: boolean): FanOutReport {
  const targets = distributionTargets();
  const actions: FanOutAction[] = [];
  let alreadyCorrect = 0;
  const expected = new Set(names);

  for (const def of targets) {
    const { agent, dir } = def;

    if (!fs.existsSync(dir) && !dryRun) fs.mkdirSync(dir, { recursive: true });

    for (const name of names) {
      const at = path.join(dir, name);
      const want = path.join(AGENTS_SKILLS, name);
      const state = inspectLink(at, want);

      if (state.kind === "linked-correctly") {
        alreadyCorrect++;
        continue;
      }
      if (state.kind === "real-dir" || state.kind === "real-file") {
        actions.push({
          kind: "blocked",
          agent,
          name,
          at,
          why: `a real ${state.kind === "real-dir" ? "directory" : "file"} is in the way`,
        });
        continue;
      }
      if (state.kind === "linked-elsewhere") {
        if (!dryRun) {
          fs.unlinkSync(at);
          symlinkSync(linkTarget(dir, name), at);
        }
        actions.push({ kind: "repointed", agent, name, at, was: state.target });
        continue;
      }
      if (!dryRun) symlinkSync(linkTarget(dir, name), at);
      actions.push({ kind: "linked", agent, name, at });
    }

    // Skills that left the store leave a dangling link behind. Prune only our
    // own — a link into the store naming something the store no longer has.
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || expected.has(e.name)) continue;
      const at = path.join(dir, e.name);
      if (!e.isSymbolicLink() || !pointsIntoStore(at)) continue;
      if (!dryRun) fs.unlinkSync(at);
      actions.push({ kind: "pruned", agent, name: e.name, at });
    }
  }

  return { targets, actions, alreadyCorrect };
}

/** Skill names an agent should be able to load: present in the store, with a SKILL.md. */
export function distributableNames(): string[] {
  const dir = storeSkills();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(dir, name, "SKILL.md")))
    .sort();
}

/** Print a report. Returns true when nothing was blocked. */
export function printFanOut(report: FanOutReport, dryRun: boolean): boolean {
  const { targets, actions, alreadyCorrect } = report;

  if (targets.length === 0) {
    console.log("fan-out: no agents enabled — `agent-skills agents` to see the list");
    return true;
  }

  const lead = dryRun ? "would " : "";
  console.log(
    `fan-out: ${targets.length} agent(s) enabled (${targets.map((t) => t.agent).join(", ")})`,
  );

  const blocked = actions.filter((a) => a.kind === "blocked");
  for (const a of actions) {
    if (a.kind === "linked") console.log(`  ${lead}link      ${a.agent}: ${a.name}`);
    else if (a.kind === "repointed") console.log(`  ${lead}repoint   ${a.agent}: ${a.name} (was ${tilde(a.was)})`);
    else if (a.kind === "pruned") console.log(`  ${lead}prune     ${a.agent}: ${a.name} (gone from the store)`);
  }
  for (const a of blocked) {
    console.error(`  SKIPPED  ${a.agent}: ${a.name} — ${a.why} at ${tilde(a.at)}`);
    console.error("    not removed; inspect it, then delete it by hand and re-run");
  }

  if (actions.length === 0) {
    console.log(`fan-out: up to date (${alreadyCorrect} link(s))`);
  }
  return blocked.length === 0;
}

export type InstructionAction =
  | { kind: "linked"; agent: string; at: string }
  | { kind: "imported"; agent: string; at: string }
  | { kind: "ok"; agent: string; at: string }
  | { kind: "repointed"; agent: string; at: string; was: string }
  | { kind: "manual"; agent: string; at: string };

/**
 * The line that makes an agent read the store's AGENTS.md without a symlink.
 *
 * Every agent that reads a Markdown instruction file supports `@path` imports,
 * so this is a real second wiring, not a note to the user. Exported because
 * `doctor` looks for it: a hand-written instruction file carrying this line is
 * wired, and reporting it as unwired would be wrong.
 */
export const IMPORT_LINE = `@${tilde(AGENTS_MD)}`;

/**
 * Whether a real instruction file already pulls the store in with `@`.
 *
 * Both spellings count. `~` is what this tool writes and what it tells people
 * to add — it survives a different `$HOME`, and the agents that read these
 * files expand it. An absolute path is equally valid though, and is what
 * someone copying from a shell prompt tends to end up with. Matching only one
 * form would report a wired file as unwired and send its owner to add a line
 * that is already there.
 */
export function importsStore(at: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(at, "utf8");
  } catch {
    return false;
  }
  return text.includes(IMPORT_LINE) || text.includes(`@${AGENTS_MD}`);
}

/**
 * Draw the link, or fall back to an import file where symlinks are unavailable.
 *
 * Windows needs a privilege for symlinks that a normal account only holds with
 * Developer Mode on. For skills there is no way around it — an agent expects a
 * directory it can traverse. An instruction file is different: one line of
 * Markdown does the same job, so failing the whole fan-out over a privilege
 * would be a choice, not a constraint. Try the link first anyway; where it
 * works it stays a single source with nothing to drift.
 */
function linkOrImport(at: string): "linked" | "imported" {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  try {
    symlinkSync(path.relative(path.dirname(at), AGENTS_MD), at);
    return "linked";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EACCES") throw err;
    fs.writeFileSync(at, `${IMPORT_LINE}\n`, "utf8");
    return "imported";
  }
}

/**
 * Point each enabled agent's global instruction file at `~/.agents/AGENTS.md`.
 *
 * Same fan-out shape as the skills above, with one deliberate difference: a
 * real file here is never moved aside. `link` may migrate a real `~/.agents/
 * skills` dir into the store because that dir is this tool's own concern, but
 * an agent's instruction file is prose someone wrote for themselves, and a
 * tool that renames it to `.bak` to install its own has overstepped. The three
 * states are: absent (link it), already ours (leave it), anything real (print
 * the one-line import and change nothing).
 *
 * The import route is not a lesser fallback — it is how two sources of
 * instruction coexist, and it is what makes this safe to run on a machine
 * whose agents were configured by someone other than this tool.
 */
export function reconcileInstructions(dryRun: boolean): InstructionAction[] {
  const out: InstructionAction[] = [];

  for (const def of distributionTargets()) {
    const at = def.instructions;
    if (at === undefined) continue; // unknown location — see AgentDef.instructions

    const state = inspectLink(at, AGENTS_MD);
    switch (state.kind) {
      case "linked-correctly":
        out.push({ kind: "ok", agent: def.agent, at });
        break;
      case "missing": {
        // Dry run cannot know whether the symlink would be permitted, so it
        // reports the intended action. "linked" is the honest guess: the
        // fallback only fires on a privilege error we have not hit yet.
        const how = dryRun ? "linked" : linkOrImport(at);
        out.push({ kind: how, agent: def.agent, at });
        break;
      }
      case "linked-elsewhere":
        // A symlink holds no bytes of its own, so repointing loses nothing.
        if (!dryRun) {
          fs.unlinkSync(at);
          linkOrImport(at);
        }
        out.push({ kind: "repointed", agent: def.agent, at, was: state.target });
        break;
      default:
        // A real file that already imports the store is wired, by the second
        // route rather than the first. Telling its owner to add a line they
        // already have would be noise, and would read as if it had not worked.
        out.push({ kind: importsStore(at) ? "ok" : "manual", agent: def.agent, at });
        break;
    }
  }
  return out;
}

/** Print the instruction fan-out. Always true: `manual` is advice, not failure. */
export function printInstructions(actions: InstructionAction[], dryRun: boolean): boolean {
  if (actions.length === 0) return true;
  const lead = dryRun ? "would " : "";

  for (const a of actions) {
    if (a.kind === "linked") console.log(`  ${lead}link      ${a.agent}: ${tilde(a.at)}`);
    else if (a.kind === "imported") console.log(`  import    ${a.agent}: ${tilde(a.at)} (symlink not permitted here)`);
    else if (a.kind === "repointed") console.log(`  ${lead}repoint   ${a.agent}: ${tilde(a.at)} (was ${tilde(a.was)})`);
    else if (a.kind === "manual") {
      console.log(`  keep      ${a.agent}: ${tilde(a.at)} already exists — not touched`);
      console.log(`    to load the store's AGENTS.md too, add this line to it:`);
      console.log(`      ${IMPORT_LINE}`);
    }
  }
  return true;
}
