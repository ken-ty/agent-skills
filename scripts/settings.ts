/**
 * Claude Code's global settings, declared in the store and applied by hand.
 *
 *   agent-skills settings diff   [store]                          read-only; exit 0 = same, 1 = differs
 *   agent-skills settings import (<store> | --to <file>) [--dry-run]
 *   agent-skills settings apply  [store] [--yes]
 *
 * `store` is a store root (a worktree of it works); diff and apply default to
 * the configured store. The declaration is the file the store names as
 * `claudeSettings` in agent-skills.json.
 *
 * Why three verbs and no automatic copy: a session cannot change its own
 * permissions, and should not be able to. The store holds the reviewed
 * declaration; a person runs `apply` to make it live. `import` is the way
 * back — Claude Code adds to `permissions.allow` itself when someone presses
 * "always allow", and those additions belong in a PR, not lost on the next
 * apply.
 *
 * `apply` copies bytes. It does not expand `~` or `$HOME`: Claude Code
 * resolves both, and the store can only hold that form (its audit rejects a
 * committed home path).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { storeRoot, tilde } from "./lib/paths.ts";
import { readLayout } from "./lib/layout.ts";
import {
  CLAUDE_SETTINGS,
  PERMISSION_LISTS,
  type Settings,
  SettingsError,
  addPermissions,
  diffSettings,
  formatDiff,
  machineOnlyPermissions,
  readSettings,
} from "./lib/claude-settings.ts";

const USAGE = [
  "usage: agent-skills settings diff   [store]",
  "       agent-skills settings import (<store> | --to <file>) [--dry-run]",
  "       agent-skills settings apply  [store] [--yes]",
].join("\n");

type Args = { sub: string; store: string | null; to: string | null; dryRun: boolean; yes: boolean };

function parseArgs(argv: string[]): Args {
  const [sub = "", ...rest] = argv;
  if (!["diff", "import", "apply"].includes(sub)) throw new SettingsError(USAGE);
  const a: Args = { sub, store: null, to: null, dryRun: false, yes: false };
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const x = rest[i]!;
    if (x === "--dry-run" || x === "-n") a.dryRun = true;
    else if (x === "--yes" || x === "-y") a.yes = true;
    else if (x === "--to") a.to = rest[++i] ?? "";
    else if (x.startsWith("--to=")) a.to = x.slice("--to=".length);
    else if (x === "-h" || x === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (x.startsWith("-")) throw new SettingsError(`unknown option ${x}\n${USAGE}`);
    else positional.push(x);
  }
  if (positional.length > 1) throw new SettingsError(USAGE);
  a.store = positional[0] !== undefined ? path.resolve(positional[0]) : null;
  if (a.to !== null && sub !== "import") throw new SettingsError(`--to is for import only\n${USAGE}`);
  if (a.to === "") throw new SettingsError(`--to needs a file\n${USAGE}`);
  if (a.dryRun && sub !== "import") throw new SettingsError(`--dry-run is for import only (diff is already read-only)\n${USAGE}`);
  if (a.yes && sub !== "apply") throw new SettingsError(`--yes is for apply only\n${USAGE}`);
  return a;
}

/** The store's declaration file, from its agent-skills.json. */
function declarationOf(store: string): string {
  const layout = readLayout(store);
  if (layout.claudeSettings === null) {
    throw new SettingsError(
      `${tilde(store)} declares no Claude Code settings — add "claudeSettings": "<path>.json" to its agent-skills.json`,
    );
  }
  return layout.claudeSettings.abs;
}

function mustRead(file: string, what: string): { text: string; json: Settings } {
  const r = readSettings(file);
  if (r === null) throw new SettingsError(`${what} ${tilde(file)} does not exist`);
  return r;
}

function printHeader(declaration: string): void {
  console.log(`declared: ${tilde(declaration)}`);
  console.log(`machine:  ${tilde(CLAUDE_SETTINGS)}`);
  console.log("(+ apply adds  - apply removes  ~ apply changes; home paths written as /Users/…, $HOME or ~ count as equal)");
  console.log("");
}

function cmdDiff(a: Args): number {
  const declaration = declarationOf(a.store ?? storeRoot());
  const decl = mustRead(declaration, "declaration");
  printHeader(declaration);
  const machine = readSettings(CLAUDE_SETTINGS);
  if (machine === null) {
    console.log(`${tilde(CLAUDE_SETTINGS)} does not exist — apply would create it`);
    return 1;
  }
  const entries = diffSettings(decl.json, machine.json);
  if (entries.length === 0) {
    console.log(decl.text === machine.text ? "identical" : "same settings (only formatting or home-path spelling differs)");
    return 0;
  }
  console.log(formatDiff(entries));
  return 1;
}

/**
 * The primary checkout of a repo that asked not to be written in directly
 * (`.primary-write-guard`, or `git config hooks.primaryWriteGuard true` — the
 * same opt-in the store's write guard reads). Import writes a file meant for
 * a PR, so it belongs on a worktree.
 */
function guardedPrimaryCheckout(file: string): string | null {
  const dir = path.dirname(file);
  const git = (...args: string[]): string | null => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const top = git("rev-parse", "--show-toplevel");
  if (top === null) return null;
  const gitDir = git("rev-parse", "--absolute-git-dir");
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  if (gitDir === null || common === null || path.resolve(gitDir) !== path.resolve(common)) return null;
  const optedIn =
    fs.existsSync(path.join(top, ".primary-write-guard")) || git("config", "--get", "hooks.primaryWriteGuard") === "true";
  return optedIn ? top : null;
}

function cmdImport(a: Args): number {
  if (a.store === null && a.to === null) {
    throw new SettingsError(
      `import writes into a declaration — name a store worktree or a file\n${USAGE}`,
    );
  }
  if (a.store !== null && a.to !== null) throw new SettingsError(`give a store or --to, not both\n${USAGE}`);
  const target = a.to !== null ? path.resolve(a.to) : declarationOf(a.store!);
  const decl = mustRead(target, "declaration");
  const machine = mustRead(CLAUDE_SETTINGS, "machine settings");

  const guarded = a.dryRun ? null : guardedPrimaryCheckout(target);
  if (guarded !== null) {
    throw new SettingsError(
      `${tilde(target)} is in the primary checkout of ${tilde(guarded)}, which is guarded ` +
        "(.primary-write-guard) — make a worktree and import into that instead:\n" +
        `  git -C ${tilde(guarded)} worktree add .worktrees/settings-import -b settings-import origin/main`,
    );
  }

  const added = machineOnlyPermissions(decl.json, machine.json);
  console.log(`declared: ${tilde(target)}`);
  console.log(`machine:  ${tilde(CLAUDE_SETTINGS)}`);
  console.log("");
  if (added.length === 0) {
    console.log("permissions: nothing on this machine is missing from the declaration");
  } else {
    console.log(`permissions: ${a.dryRun ? "would add" : "added"} ${added.length} entr${added.length === 1 ? "y" : "ies"}`);
    for (const { list, item } of added) console.log(`  + permissions.${list}: ${item}`);
  }

  // Everything else is reported, never imported: dropping a declared entry,
  // or taking a hook or a model switch from the machine, is a decision for a
  // person reading the PR, not a mechanical sync.
  const lists = new Set(PERMISSION_LISTS.map((l) => `permissions.${l}`));
  const rest = diffSettings(decl.json, machine.json).filter((e) => !(lists.has(e.key) && e.op === "remove"));
  const declaredOnly = rest.filter((e) => lists.has(e.key) && e.op === "add");
  if (declaredOnly.length > 0) {
    console.log("");
    console.log(`declared but not on this machine (kept — apply will add them): ${declaredOnly.length}`);
    for (const e of declaredOnly) console.log(`  = ${e.key}: ${e.text}`);
  }
  const others = [...new Set(rest.filter((e) => !lists.has(e.key)).map((e) => e.key))];
  if (others.length > 0) {
    console.log("");
    console.log(`not imported (see \`agent-skills settings diff\`): ${others.join(", ")}`);
  }

  if (added.length > 0 && !a.dryRun) {
    fs.writeFileSync(target, `${JSON.stringify(addPermissions(decl.json, added), null, 2)}\n`);
    console.log("");
    console.log(`wrote ${tilde(target)} — review and commit it as a PR`);
  }
  return 0;
}

function stamp(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** `settings.json.bak-<stamp>`, never overwriting an earlier backup. */
function backup(file: string): string {
  const base = `${file}.bak-${stamp()}`;
  for (let n = 0; ; n++) {
    const dest = n === 0 ? base : `${base}-${n}`;
    try {
      fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

async function cmdApply(a: Args): Promise<number> {
  const declaration = declarationOf(a.store ?? storeRoot());
  const decl = mustRead(declaration, "declaration");

  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(CLAUDE_SETTINGS);
  } catch {
    st = null;
  }
  if (st?.isSymbolicLink()) {
    throw new SettingsError(
      `${tilde(CLAUDE_SETTINGS)} is a symlink — apply writes a real file and will not replace a link it did not make. ` +
        "Remove or move the link first.",
    );
  }

  printHeader(declaration);
  const machine = st === null ? null : readSettings(CLAUDE_SETTINGS);
  if (machine !== null && machine.text === decl.text) {
    console.log("already applied — nothing to do");
    return 0;
  }
  if (machine === null) console.log(`${tilde(CLAUDE_SETTINGS)} does not exist — apply will create it`);
  else {
    const entries = diffSettings(decl.json, machine.json);
    console.log(entries.length === 0 ? "same settings; only formatting or home-path spelling differs" : formatDiff(entries));
    if (entries.some((e) => e.op === "remove" && e.key.startsWith("permissions."))) {
      console.log("");
      console.log("(- lines under permissions are lost on apply. Keep them with `agent-skills settings import <store worktree>` first.)");
    }
  }
  console.log("");

  if (!a.yes) {
    if (!process.stdin.isTTY) {
      console.error("not a terminal — rerun with --yes to apply without asking");
      return 1;
    }
    if (!(await confirm(`apply to ${tilde(CLAUDE_SETTINGS)}? [y/N] `))) {
      console.log("not applied");
      return 1;
    }
  }

  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  const saved = machine !== null ? backup(CLAUDE_SETTINGS) : null;
  // Write beside it and rename, so Claude Code never reads half a file.
  const tmp = `${CLAUDE_SETTINGS}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, decl.text, { mode: st !== null ? st.mode & 0o777 : 0o644 });
  fs.renameSync(tmp, CLAUDE_SETTINGS);
  if (saved !== null) console.log(`saved the previous file as ${tilde(saved)}`);
  console.log(`applied ${tilde(declaration)} -> ${tilde(CLAUDE_SETTINGS)}`);
  return 0;
}

// diff's 1 means "differs", so a failure has to be something else: 2, like diff(1).
try {
  const a = parseArgs(process.argv.slice(2));
  process.exitCode = a.sub === "diff" ? cmdDiff(a) : a.sub === "import" ? cmdImport(a) : await cmdApply(a);
} catch (e) {
  // A message the user can act on prints alone (as run.js does); anything else keeps its stack.
  console.error((e as { actionable?: boolean })?.actionable === true ? (e as Error).message : e);
  process.exitCode = 2;
}
