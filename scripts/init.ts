/**
 * Scaffold a new, empty store repo and wire it into this machine.
 *
 *   agent-skills init <dir>     # or run in an empty dir with no arg
 *
 * Creates the store layout (skills/, catalog.json, skills/.gitignore), runs
 * `git init`, then hands off to `link` to record the path, point ~/.agents at
 * it, and install the audit hook. Existing files are left untouched, so it is
 * safe to re-run.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CLI_ROOT, tilde } from "./lib/paths.ts";

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("-"));
const dir = path.resolve(positional[0] ?? process.cwd());

/** Same markers sync.ts rewrites — an empty managed block, ready for `sync`. */
const GITIGNORE_BLOCK = [
  "# --- managed by scripts/sync.ts (do not edit) ---",
  "# 3rd-party skills: tracked in ../skills.lock, restored by `agent-skills sync`.",
  "# --- end managed ---",
  "",
].join("\n");

const CATALOG = `${JSON.stringify({ version: 1, skills: {} }, null, 2)}\n`;

const README = `# agent-skills store

Personal store for [agent-skills](https://github.com/ken-ty/agent-skills). Holds
own / remote / vendored skills; the \`agent-skills\` CLI operates on this repo.

- \`skills/<name>/SKILL.md\` — skill bodies (own + vendored committed; remote gitignored)
- \`catalog.json\` — provenance (kind / author / refs) for every skill
- \`skills.lock\` — how remote skills are re-fetched (written by \`npx skills\`)

See the CLI repo for how kinds work and how to add skills.
`;

function writeIfAbsent(file: string, contents: string): void {
  if (fs.existsSync(file)) {
    console.log(`  keep  ${tilde(file)} (exists)`);
    return;
  }
  fs.writeFileSync(file, contents);
  console.log(`  write ${tilde(file)}`);
}

function main(): void {
  console.log(`init: ${tilde(dir)}\n`);

  fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
  writeIfAbsent(path.join(dir, "skills", ".gitignore"), GITIGNORE_BLOCK);
  writeIfAbsent(path.join(dir, "catalog.json"), CATALOG);
  writeIfAbsent(path.join(dir, "README.md"), README);
  writeIfAbsent(path.join(dir, ".gitignore"), "node_modules/\n.DS_Store\n");

  if (!fs.existsSync(path.join(dir, ".git"))) {
    console.log("  git init");
    spawnSync("git", ["init", "-q"], { cwd: dir });
  } else {
    console.log("  keep  .git (exists)");
  }
  console.log("");

  // Hand off to link for config, ~/.agents wiring, and the hook. One source of
  // truth for that logic rather than a second copy here.
  const runJs = path.join(CLI_ROOT, "scripts", "run.js");
  const r = spawnSync(process.execPath, [runJs, "link", dir], { stdio: "inherit" });
  if (r.status !== 0) process.exitCode = r.status ?? 1;
}

main();
