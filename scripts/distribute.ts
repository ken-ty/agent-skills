/**
 * Make every enabled agent dir mirror the store.
 *
 *   agent-skills distribute            create / repair / prune the symlinks
 *   agent-skills distribute --dry-run  same report, no writes
 *
 * `agent-skills agents` chooses the targets; this applies them. `sync` runs the
 * same reconcile at the end of its own work, so a normal day never needs this
 * command — it exists for when you have just enabled an agent and want the
 * links now, without a fetch.
 */
import { distributableNames, printFanOut, reconcileFanOut } from "./lib/fanout.ts";
import { storeSkills, tilde } from "./lib/paths.ts";

const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");

function main(): void {
  const names = distributableNames();
  if (names.length === 0) {
    console.error(`No loadable skills in ${tilde(storeSkills())} — nothing to distribute.`);
    console.error("  a skill needs SKILL.md at its root to be seen by an agent");
    process.exitCode = 1;
    return;
  }

  console.log(`store: ${names.length} loadable skill(s)`);
  const report = reconcileFanOut(names, dryRun);
  if (!printFanOut(report, dryRun)) process.exitCode = 1;
}

main();
