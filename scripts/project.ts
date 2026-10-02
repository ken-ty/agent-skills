/**
 * Place a store's per-project defaults into a git repo.
 *
 *   agent-skills project init --level <level> [dir]   place them (idempotent)
 *   agent-skills project init --level <level> --dry-run [dir]
 *
 * The templates are the store's, not this tool's: the store declares a
 * directory in agent-skills.json (`"project": "agents/project"`) with one
 * subdirectory per level. Each level may hold
 *
 *   extends     one line, another level to start from (its files lose to ours)
 *   files/      copied to the repo root as-is
 *   ignore      lines appended to .gitignore when missing
 *   exclude     lines appended to .git/info/exclude when missing
 *   git-config  key=value lines written with `git config --local`
 *
 * Nothing that exists is overwritten. A file, ignore line or config value that
 * is already there and agrees is kept; one that disagrees is reported and left
 * alone, so a second run changes nothing and a repo's own choices survive.
 *
 * The level is never guessed. Which level a repo is (whose it is, who else
 * sees it) is a judgment this command has no inputs for, so omitting --level
 * is an error rather than a default.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gitToplevel, storeLayout, tilde } from "./lib/paths.ts";

class UsageError extends Error {
  readonly actionable = true;
}

const USAGE = "usage: agent-skills project init --level <level> [--dry-run] [dir]";

type Level = {
  files: Map<string, string>; // repo-relative (posix) -> absolute source
  ignore: string[];
  exclude: string[];
  config: Map<string, string>;
};

type Outcome = "write" | "keep" | "differs";

function parseArgs(argv: string[]): { level: string | null; dryRun: boolean; dir: string } {
  const [sub, ...rest] = argv;
  if (sub !== "init") throw new UsageError(USAGE);
  let level: string | null = null;
  let dryRun = false;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--dry-run" || a === "-n") dryRun = true;
    else if (a === "--level") level = rest[++i] ?? "";
    else if (a.startsWith("--level=")) level = a.slice("--level=".length);
    else if (a.startsWith("-")) throw new UsageError(`unknown option ${a}\n${USAGE}`);
    else positional.push(a);
  }
  if (positional.length > 1) throw new UsageError(USAGE);
  return { level, dryRun, dir: path.resolve(positional[0] ?? process.cwd()) };
}

function readLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

function walk(dir: string, base: string, out: Map<string, string>): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = base === "" ? e.name : `${base}/${e.name}`;
    if (e.isDirectory()) walk(abs, rel, out);
    else if (e.isFile()) out.set(rel, abs);
  }
}

function levelNames(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/** The level with its `extends` chain applied, base first. */
function resolveLevel(root: string, name: string, seen: string[] = []): Level {
  if (seen.includes(name)) throw new UsageError(`levels extend each other in a loop: ${[...seen, name].join(" -> ")}`);
  const dir = path.join(root, name);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new UsageError(`no level "${name}" in ${tilde(root)} (have: ${levelNames(root).join(", ")})`);
  }
  const parent = readLines(path.join(dir, "extends"))[0];
  const level: Level = parent
    ? resolveLevel(root, parent, [...seen, name])
    : { files: new Map(), ignore: [], exclude: [], config: new Map() };
  walk(path.join(dir, "files"), "", level.files);
  for (const l of readLines(path.join(dir, "ignore"))) if (!level.ignore.includes(l)) level.ignore.push(l);
  for (const l of readLines(path.join(dir, "exclude"))) if (!level.exclude.includes(l)) level.exclude.push(l);
  for (const l of readLines(path.join(dir, "git-config"))) {
    const eq = l.indexOf("=");
    if (eq <= 0) throw new UsageError(`${tilde(path.join(dir, "git-config"))}: "${l}" is not key=value`);
    level.config.set(l.slice(0, eq).trim(), l.slice(eq + 1).trim());
  }
  return level;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

function isExec(file: string): boolean {
  return (fs.statSync(file).mode & 0o111) !== 0;
}

/** Same bytes, and executable when the template is. */
function sameFile(src: string, dst: string): boolean {
  const st = fs.statSync(dst, { throwIfNoEntry: false });
  if (!st?.isFile()) return false;
  if (!fs.readFileSync(src).equals(fs.readFileSync(dst))) return false;
  return process.platform === "win32" || !isExec(src) || isExec(dst);
}

function placeFile(src: string, dst: string, dryRun: boolean): Outcome {
  if (fs.existsSync(dst)) return sameFile(src, dst) ? "keep" : "differs";
  if (!dryRun) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, fs.statSync(src).mode & 0o777);
  }
  return "write";
}

function missingLines(file: string, lines: string[]): string[] {
  const have = new Set(fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()) : []);
  return lines.filter((l) => !have.has(l));
}

function appendLines(file: string, lines: string[], dryRun: boolean): string[] {
  const missing = missingLines(file, lines);
  if (missing.length > 0 && !dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const sep = cur === "" || cur.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(file, `${sep}${missing.join("\n")}\n`);
  }
  return missing;
}

function main(): void {
  const { level: levelName, dryRun, dir } = parseArgs(process.argv.slice(2));

  const layout = storeLayout();
  if (layout.project === null) {
    throw new UsageError(
      `the store (${tilde(layout.root)}) declares no project templates — add "project": "<dir>" to its agent-skills.json`,
    );
  }
  const root = layout.project.abs;
  if (!fs.existsSync(root)) throw new UsageError(`project templates ${tilde(root)} do not exist`);
  if (levelName === null || levelName === "") {
    throw new UsageError(
      `--level is required (one of: ${levelNames(root).join(", ")}).\n` +
        "This command does not guess the level — deciding it is the job of the project-agents-md skill (or your own policy).",
    );
  }
  const level = resolveLevel(root, levelName);

  const top = gitToplevel(dir);
  if (top === null) throw new UsageError(`${tilde(dir)} is not inside a git repo — run \`git init\` there first`);

  console.log(`project init${dryRun ? " (dry run)" : ""}: ${tilde(top)}  level=${levelName}  from ${tilde(root)}\n`);
  const verb = (o: Outcome): string => (o === "write" && dryRun ? "would write" : o);
  const counts: Record<Outcome, number> = { write: 0, keep: 0, differs: 0 };
  const written: Array<[string, string]> = [];
  const keptConfig = new Set<string>(); // keys that already had another value

  for (const [rel, src] of [...level.files].sort(([a], [b]) => a.localeCompare(b))) {
    const dst = path.join(top, ...rel.split("/"));
    const o = placeFile(src, dst, dryRun);
    counts[o]++;
    if (o === "write") written.push([src, dst]);
    console.log(`  ${verb(o).padEnd(11)} ${rel}${o === "differs" ? "  (exists with other content — left as is)" : ""}`);
  }

  const exclude = git(top, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]).out;
  const lineTargets: Array<[string, string, string[]]> = [
    [".gitignore", path.join(top, ".gitignore"), level.ignore],
    [".git/info/exclude", exclude, level.exclude],
  ];
  for (const [label, file, lines] of lineTargets) {
    if (lines.length === 0) continue;
    const added = appendLines(file, lines, dryRun);
    if (added.length === 0) console.log(`  ${"keep".padEnd(11)} ${label}  (has all ${lines.length} lines)`);
    else console.log(`  ${(dryRun ? "would add" : "append").padEnd(11)} ${label}  + ${added.join(" ")}`);
  }

  for (const [key, want] of level.config) {
    const have = git(top, ["config", "--local", "--get", key]);
    if (have.ok && have.out === want) {
      console.log(`  ${"keep".padEnd(11)} git config ${key}=${want}`);
    } else if (have.ok) {
      counts.differs++;
      keptConfig.add(key);
      console.log(`  ${"differs".padEnd(11)} git config ${key}=${have.out}  (template says ${want} — left as is)`);
    } else {
      if (!dryRun) git(top, ["config", "--local", key, want]);
      console.log(`  ${(dryRun ? "would set" : "set").padEnd(11)} git config ${key}=${want}`);
    }
  }

  console.log("");
  if (dryRun) return;

  // Read back what this run should have left behind. Cheap, and it is the
  // only way to notice a write that silently did not land (a read-only
  // checkout, a hook that is not executable).
  const problems: string[] = [];
  for (const [src, dst] of written) if (!sameFile(src, dst)) problems.push(`${tilde(dst)} does not match its template`);
  for (const [label, file, lines] of lineTargets) {
    const left = missingLines(file, lines);
    if (left.length > 0) problems.push(`${label} is missing: ${left.join(" ")}`);
  }
  for (const [key, want] of level.config) {
    if (keptConfig.has(key)) continue;
    const have = git(top, ["config", "--local", "--get", key]);
    if (have.out !== want) problems.push(`git config ${key} is "${have.out}", expected "${want}"`);
  }
  if (problems.length > 0) {
    console.error("check: FAILED");
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 1;
    return;
  }
  console.log(`check: ok — ${counts.write} written, ${counts.keep} kept, ${counts.differs} differ`);
  if (counts.differs > 0) {
    console.log("  differing entries were left as they are; compare them with the template by hand");
  }
}

main();
