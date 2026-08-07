/**
 * Wire an existing store repo into this machine:
 *   1. record the store path in ~/.config/agent-skills/config.json
 *   2. point ~/.agents/{skills,.skill-lock.json} at the store
 *   3. install the pre-commit audit hook into the store and set core.hooksPath
 *
 *   agent-skills link <store-dir>     # or run from inside the store with no arg
 *
 * Idempotent. Never deletes data: a real dir/file in the way is moved aside to
 * `.bak-<ts>`; a symlink pointing elsewhere is repointed (a symlink holds no
 * data). Run with --dry-run first.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  AGENTS_DIR,
  AGENTS_LOCK,
  AGENTS_SKILLS,
  HOOKS_DIR_NAME,
  HOOK_TEMPLATE,
  gitHooksPath,
  inspectLink,
  tilde,
} from "./lib/paths.ts";
import { writeConfig } from "./lib/store.ts";
import { symlinkSync } from "./lib/symlink.ts";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run") || argv.includes("-n");
const positional = argv.filter((a) => !a.startsWith("-"));
const storeDir = path.resolve(positional[0] ?? process.cwd());
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
  act(`ln -s ${tilde(to)} ${tilde(from)}`, () => symlinkSync(to, from));
}

/**
 * Migrate a pre-existing real directory at `from` into the store: move each
 * child across, then rename the (now-empty) original to .bak-<ts>.
 * Children whose name already exists in the store are left in place and reported.
 */
function migrateDir(from: string, to: string): boolean {
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
      `${tilde(from)} still holds entries that already exist in the store: ` +
        `${conflicts.join(", ")}. Reconcile them by hand, then re-run.`,
    );
    return false;
  }

  act(`mv ${tilde(from)} -> ${tilde(from)}.bak-${stamp}`, () =>
    fs.renameSync(from, `${from}.bak-${stamp}`),
  );
  return true;
}

/** Migrate a pre-existing real file at `from` into the store, keeping a backup. */
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

/** A symlink carries no data, so repointing it is safe and is the point here. */
function repoint(from: string, to: string, oldTarget: string): void {
  act(`rm ${tilde(from)} (was -> ${tilde(oldTarget)})`, () => fs.unlinkSync(from));
  symlink(from, to);
}

/**
 * Install the audit hook into the store and point git at it.
 *
 * Version-controlled hooks reach every clone, but core.hooksPath is repo-local
 * config (.git/config) that a clone does not inherit — so each machine opts in
 * once, which is what this command is for.
 */
function installHook(): void {
  if (!fs.existsSync(path.join(storeDir, ".git"))) {
    console.log(`  skipped — ${tilde(storeDir)} is not a git repo yet (\`git init\` first)`);
    return;
  }
  const hooksDir = path.join(storeDir, HOOKS_DIR_NAME);
  const dest = path.join(hooksDir, "pre-commit");
  ensureDir(hooksDir);
  act(`cp ${tilde(HOOK_TEMPLATE)} -> ${tilde(dest)} (+x)`, () => {
    fs.copyFileSync(HOOK_TEMPLATE, dest);
    fs.chmodSync(dest, 0o755);
  });

  const current = gitHooksPath(storeDir);
  if (current === HOOKS_DIR_NAME) {
    console.log("  ok (core.hooksPath already set)");
    return;
  }
  if (current !== null) {
    fail(`core.hooksPath is already ${current}. Reconcile by hand, then re-run.`);
    return;
  }
  act(`git config core.hooksPath ${HOOKS_DIR_NAME}`, () => {
    spawnSync("git", ["config", "core.hooksPath", HOOKS_DIR_NAME], { cwd: storeDir });
  });
}

function main(): void {
  console.log(dryRun ? "link (dry run — nothing will change)\n" : "link\n");

  if (!fs.existsSync(storeDir) || !fs.statSync(storeDir).isDirectory()) {
    console.error(`ERROR: store dir ${tilde(storeDir)} does not exist.`);
    console.error("  Pass a path (`agent-skills link <dir>`) or run from inside the store.");
    process.exitCode = 1;
    return;
  }

  console.log(`store: ${tilde(storeDir)}`);
  act(`write ${tilde(path.join("~/.config/agent-skills", "config.json"))}`, () =>
    writeConfig({ store: storeDir }),
  );
  console.log("");

  ensureDir(path.join(storeDir, "skills"));
  ensureDir(AGENTS_DIR);

  // Targets come straight from storeDir, not from config: link is what writes
  // the config, so it cannot read the store path back out of it yet.
  const linkTargets = [
    { label: "skills", from: AGENTS_SKILLS, to: path.join(storeDir, "skills") },
    { label: "lock", from: AGENTS_LOCK, to: path.join(storeDir, "skills.lock") },
  ];
  for (const { label, from, to } of linkTargets) {
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
        // Explicitly pointing at this store, so repoint rather than refuse.
        repoint(from, to, state.target);
        break;
    }
    console.log("");
  }

  console.log(`hooks: ${tilde(storeDir)}/${HOOKS_DIR_NAME}/pre-commit`);
  installHook();
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
  console.log("Done. Verify with `agent-skills doctor`.");
}

main();
