/**
 * Show and change which agents the store distributes to.
 *
 *   agent-skills agents                    list every known agent and its state
 *   agent-skills agents enable <name>      start feeding it symlinks
 *   agent-skills agents disable <name>     stop (existing links are left alone)
 *
 * Listing is the point: the set of directories this tool writes into should be
 * readable at a glance, not inferred from code. `enable` / `disable` only edit
 * ~/.config/agent-skills/config.json — editing that file by hand is equally
 * supported and does the same thing.
 *
 * Neither subcommand touches the filesystem outside the config file. Run
 * `agent-skills distribute` (or `sync`) to make the links match.
 */
import fs from "node:fs";
import {
  AGENT_NAMES,
  agentSettings,
  findAgent,
  setAgentDistribution,
} from "./lib/agents.ts";
import { AGENTS_SKILLS, inspectLink, tilde } from "./lib/paths.ts";
import { CONFIG_PATH } from "./lib/store.ts";
import path from "node:path";

const argv = process.argv.slice(2);
const [action, name] = argv;

/** One-line summary of what is actually in an agent dir right now. */
function describe(dir: string): string {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return "not present";
  }
  const visible = entries.filter((e) => !e.name.startsWith("."));
  if (visible.length === 0) return "empty";

  let linked = 0;
  let foreign = 0;
  let real = 0;
  for (const e of visible) {
    const at = path.join(dir, e.name);
    const state = inspectLink(at, path.join(AGENTS_SKILLS, e.name));
    if (state.kind === "linked-correctly") linked++;
    else if (e.isSymbolicLink()) foreign++;
    else real++;
  }
  const parts = [`${linked} linked`];
  if (foreign > 0) parts.push(`${foreign} other link(s)`);
  if (real > 0) parts.push(`${real} real dir(s)`);
  return parts.join(", ");
}

function list(): void {
  const settings = agentSettings();
  const width = Math.max(...settings.map((s) => s.def.agent.length));

  console.log(`config: ${tilde(CONFIG_PATH)}  (edit the "agents" object directly, or use enable/disable)\n`);
  for (const { def, enabled, source } of settings) {
    const mark = enabled ? "on " : "off";
    const why =
      source === "canonical"
        ? "is the store itself — never linked into"
        : source === "config"
          ? "from config"
          : `default (${def.defaultDistribute})`;
    console.log(
      `  ${mark}  ${def.agent.padEnd(width)}  ${tilde(def.dir).padEnd(34)}  ${describe(def.dir).padEnd(24)}  ${why}`,
    );
  }
  console.log("\n  agent-skills agents enable <name> | disable <name>");
  console.log("  agent-skills distribute            apply the links");
}

function toggle(enabled: boolean): void {
  if (name === undefined) {
    console.error(`usage: agent-skills agents ${enabled ? "enable" : "disable"} <name>`);
    console.error(`  known agents: ${AGENT_NAMES.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const def = findAgent(name);
  if (def === null) {
    console.error(`unknown agent: ${name}`);
    console.error(`  known agents: ${AGENT_NAMES.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  // Honouring `enable warp` would mean linking ~/.agents/skills into itself.
  // Refuse loudly rather than write a setting that is then silently ignored.
  if (def.canonical) {
    console.error(`${def.agent} reads ${tilde(def.dir)} — the store itself. There is nothing to link.`);
    process.exitCode = 1;
    return;
  }

  try {
    setAgentDistribution(def.agent, enabled);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  console.log(`${def.agent}: ${enabled ? "enabled" : "disabled"} (${tilde(CONFIG_PATH)})`);
  console.log(
    enabled
      ? "  run `agent-skills distribute` to create the links"
      : "  existing links were left in place — remove them by hand if you want them gone",
  );
}

function main(): void {
  if (action === undefined) return list();
  if (action === "enable") return toggle(true);
  if (action === "disable") return toggle(false);
  console.error(`usage: agent-skills agents [enable|disable <name>]`);
  process.exitCode = 1;
}

main();
