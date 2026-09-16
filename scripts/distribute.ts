/**
 * Make every enabled agent dir mirror the store.
 *
 *   agent-skills distribute            create / repair / prune the symlinks,
 *                                      copy the store's claude/ where missing
 *   agent-skills distribute --dry-run  same report, no writes
 *   agent-skills distribute --force    also overwrite a ~/.claude copy that drifted
 *
 * `agent-skills agents` chooses the targets; this applies them. `sync` runs the
 * same reconcile at the end of its own work, so a normal day never needs this
 * command — it exists for when you have just enabled an agent and want the
 * links now, without a fetch.
 */
import {
  distributableNames,
  printClaudeConfig,
  printFanOut,
  printInstructions,
  reconcileClaudeConfig,
  reconcileFanOut,
  reconcileInstructions,
} from "./lib/fanout.ts";
import { storeSkills, tilde } from "./lib/paths.ts";

const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
const force = process.argv.includes("--force");

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
  const ok = printFanOut(report, dryRun);

  // Skills load on demand; AGENTS.md loads every session. Same fan-out, same
  // enabled set, different clobber rule — see reconcileInstructions.
  printInstructions(reconcileInstructions(dryRun), dryRun);

  // Claude Code's own config is copied, not linked, because Claude Code writes
  // to it — see reconcileClaudeConfig for the clobber rule and what --force is.
  printClaudeConfig(reconcileClaudeConfig(dryRun, force), dryRun);

  if (!ok) process.exitCode = 1;
}

main();
