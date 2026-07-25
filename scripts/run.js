/**
 * Node version guard, then hand off to the real .ts script.
 *
 * The scripts are TypeScript run through Node's type stripping, on by default
 * from 22.18. On anything older `node scripts/doctor.ts` dies with
 * ERR_UNKNOWN_FILE_EXTENSION (or a bare SyntaxError), neither of which mentions
 * Node's version — a poor first error on the fresh machine this repo exists to
 * set up.
 *
 * This file is plain JS so it parses on any Node, which is the only way the
 * check can run: a guard written inside a .ts entry point sits behind the very
 * parse step that fails.
 *
 * package.json `engines` does not cover this either — npm enforces it during
 * `npm install`, and these scripts deliberately need no install.
 */
const MIN = "22.18.0";
const SCRIPTS = ["init", "link", "sync", "doctor", "audit", "list"];

/** Compare dotted versions numerically. parseInt drops tags like "-nightly". */
function isOlder(actual, min) {
  const a = actual.split(".");
  const b = min.split(".");
  for (let i = 0; i < 3; i++) {
    const x = parseInt(a[i], 10) || 0;
    const y = parseInt(b[i], 10) || 0;
    if (x !== y) return x < y;
  }
  return false;
}

const current = process.versions.node;
if (isOlder(current, MIN)) {
  console.error(`This repo needs Node >= ${MIN}, but you are on ${current}.`);
  console.error("");
  console.error("  The scripts are .ts and rely on Node's built-in type stripping,");
  console.error(`  which is enabled by default from ${MIN}. There is nothing to install —`);
  console.error("  upgrading Node is the whole fix.");
  console.error("");
  console.error("    nvm install 22   # or: brew upgrade node");
  process.exit(1);
}

const name = process.argv[2];
if (!SCRIPTS.includes(name)) {
  console.error(`usage: node scripts/run.js <${SCRIPTS.join("|")}> [args]`);
  process.exit(1);
}

// Drop the subcommand name so the script sees only its own args: it reads
// process.argv directly, and `link foo` must give it `foo`, not `link foo`.
process.argv.splice(2, 1);

await import(new URL(`./${name}.ts`, import.meta.url));
