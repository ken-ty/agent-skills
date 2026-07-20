/**
 * Point `~/.agents/{skills,.skill-lock.json}` at this repo so that everything
 * `npx skills` writes lands under version control.
 *
 * Idempotent. Never deletes: anything in the way is moved aside to `.bak-<ts>`.
 * Run with --dry-run first.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  AGENTS_DIR,
  HOOKS_DIR_NAME,
  LINKS,
  REPO_LOCK,
  REPO_ROOT,
  REPO_SKILLS,
  gitHooksPath,
  inspectLink,
  tilde,
} from "./lib/paths.ts";

const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

let failed = false;

function act(desc: string, fn: () => void): void {
  if (dryRun) {
    console.log(`  would: ${desc}`);
    return;
  }
  console.log(`  ${desc}`);
  fn();
}

function fail(msg: string): void {
  failed = true;
  console.error(`  ERROR: ${msg}`);
}

function ensureDir(dir: string): void {
  if (fs.existsSync(dir)) return;
  act(`mkdir -p ${tilde(dir)}`, () => fs.mkdirSync(dir, { recursive: true }));
}

function symlink(from: string, to: string): void {
  act(`ln -s ${tilde(to)} ${tilde(from)}`, () => fs.symlinkSync(to, from));
}

/**
 * Migrate a pre-existing real directory at `from` into the repo: move each
 * child across, then rename the (now-empty) original to .bak-<ts>.
 * Children whose name already exists in the repo are left in place and reported.
 */
function migrateDir(from: string, to: string): boolean {
  // OS cruft stays behind in the .bak dir rather than polluting the repo.
  const children = fs.readdirSync(from).filter((n) => n !== ".DS_Store");
  const conflicts: string[] = [];

  for (const name of children) {
    const dest = path.join(to, name);
    if (fs.existsSync(dest)) {
      conflicts.push(name);
      continue;
    }
    act(`mv ${tilde(path.join(from, name))} -> ${tilde(dest)}`, () =>
      fs.renameSync(path.join(from, name), dest),
    );
  }

  if (conflicts.length > 0) {
    fail(
      `${tilde(from)} still holds entries that already exist in the repo: ` +
        `${conflicts.join(", ")}. Reconcile them by hand, then re-run.`,
    );
    return false;
  }

  act(`mv ${tilde(from)} -> ${tilde(from)}.bak-${stamp}`, () =>
    fs.renameSync(from, `${from}.bak-${stamp}`),
  );
  return true;
}

/** Migrate a pre-existing real file at `from` into the repo, keeping a backup. */
function migrateFile(from: string, to: string): boolean {
  if (fs.existsSync(to)) {
    fail(
      `${tilde(from)} is a real file but ${tilde(to)} already exists. ` +
        `Reconcile them by hand, then re-run.`,
    );
    return false;
  }
  act(`cp ${tilde(from)} -> ${tilde(to)}`, () => fs.copyFileSync(from, to));
  act(`mv ${tilde(from)} -> ${tilde(from)}.bak-${stamp}`, () =>
    fs.renameSync(from, `${from}.bak-${stamp}`),
  );
  return true;
}

/**
 * Point git at the repo's own hooks dir so the pre-commit audit runs.
 *
 * This is repo-local config (.git/config), not something a clone inherits, so
 * every machine has to opt in once — which is exactly what this command is for.
 */
function linkHooks(): void {
  const current = gitHooksPath();
  if (current === HOOKS_DIR_NAME) {
    console.log("  ok (already set)");
    return;
  }
  if (current !== null) {
    fail(`core.hooksPath is already ${current}. Reconcile by hand, then re-run.`);
    return;
  }
  act(`git config core.hooksPath ${HOOKS_DIR_NAME}`, () => {
    spawnSync("git", ["config", "core.hooksPath", HOOKS_DIR_NAME], { cwd: REPO_ROOT });
  });
}

function main(): void {
  console.log(dryRun ? "link (dry run — nothing will change)\n" : "link\n");

  ensureDir(REPO_SKILLS);
  ensureDir(AGENTS_DIR);

  for (const { label, from, to } of LINKS) {
    console.log(`${label}: ${tilde(from)} -> ${tilde(to)}`);
    const state = inspectLink(from, to);

    switch (state.kind) {
      case "linked-correctly":
        console.log("  ok (already linked)");
        break;

      case "missing":
        symlink(from, to);
        break;

      case "real-dir":
        if (migrateDir(from, to)) symlink(from, to);
        break;

      case "real-file":
        if (migrateFile(from, to)) symlink(from, to);
        break;

      case "linked-elsewhere":
        // Relinking could orphan a store we know nothing about, so stop and
        // let a human decide rather than guessing.
        fail(
          `${tilde(from)} is a symlink to ${tilde(state.target)}, not to this repo. ` +
            `Remove or repoint it by hand, then re-run.`,
        );
        break;
    }
    console.log("");
  }

  console.log(`hooks: core.hooksPath -> ${HOOKS_DIR_NAME}/`);
  linkHooks();
  console.log("");

  if (failed) {
    console.error("link finished with errors — see above.");
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log("Dry run complete. Re-run without --dry-run to apply.");
    return;
  }

  if (!fs.existsSync(REPO_LOCK)) {
    console.log(
      `Note: no ${tilde(REPO_LOCK)} yet. It appears once you run \`npx skills add <source>\`.`,
    );
  }
  console.log("Done. Verify with `npm run doctor`.");
}

main();
