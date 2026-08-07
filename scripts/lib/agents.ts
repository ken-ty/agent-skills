/**
 * Which agents this store distributes to, and where each one keeps its skills.
 *
 * The store is the single source of truth; every agent sees it through a
 * per-skill symlink into `~/.agents/skills`. This module answers two questions
 * the rest of the tool asks constantly:
 *
 *   1. what agent dirs exist on this machine's registry (AGENT_REGISTRY)
 *   2. which of them the user actually wants fed (distributionTargets)
 *
 * The second is configuration, not detection. Detecting an installed agent and
 * writing into its dir uninvited is exactly what wrangler 4.119 does — it found
 * eleven agents and copied Cloudflare's skills into all of them, outside any
 * store. Presence is not consent, so nothing here is enabled by the mere fact
 * that a directory exists: the default is `claude-code` alone, and every other
 * agent is opt-in via `agent-skills agents enable <name>` or the config file.
 */
import path from "node:path";
import { AGENTS_SKILLS, HOME } from "./paths.ts";
import { readConfig, writeConfig } from "./store.ts";

export type AgentDef = {
  /** Stable id. Matches the `skills` CLI agent name where one exists. */
  agent: string;
  /** Human-facing name, as the agent calls itself. */
  display: string;
  /** Absolute path to the agent's global skills dir. */
  dir: string;
  /**
   * True when `dir` *is* the canonical store (`~/.agents/skills`). Such an
   * agent already reads every skill; linking into it would mean linking a
   * directory into itself. Never a distribution target, whatever config says.
   */
  canonical: boolean;
  /** Fed unless config says otherwise. Only claude-code — see the file header. */
  defaultDistribute: boolean;
};

/**
 * Every agent dir known to this tool.
 *
 * Paths are taken from the two registries that actually write to them: the
 * `skills` CLI, and wrangler's agent detection (which enumerated all eleven on
 * 2026-08-07 and recorded each `globalPath`). An agent absent from this list is
 * not distributed to at all — adding one is a code change on purpose, so the
 * set of directories this tool writes into stays reviewable.
 */
export const AGENT_REGISTRY: ReadonlyArray<AgentDef> = [
  {
    agent: "claude-code",
    display: "Claude Code",
    dir: path.join(HOME, ".claude", "skills"),
    canonical: false,
    defaultDistribute: true,
  },
  {
    agent: "codex",
    display: "Codex",
    dir: path.join(HOME, ".codex", "skills"),
    canonical: false,
    defaultDistribute: false,
  },
  {
    agent: "gemini-cli",
    display: "Gemini CLI",
    dir: path.join(HOME, ".gemini", "skills"),
    canonical: false,
    defaultDistribute: false,
  },
  {
    agent: "cursor",
    display: "Cursor",
    dir: path.join(HOME, ".cursor", "skills"),
    canonical: false,
    defaultDistribute: false,
  },
  {
    agent: "cline",
    display: "Cline",
    dir: path.join(HOME, ".cline", "skills"),
    canonical: false,
    defaultDistribute: false,
  },
  {
    agent: "github-copilot",
    display: "GitHub Copilot",
    dir: path.join(HOME, ".copilot", "skills"),
    canonical: false,
    defaultDistribute: false,
  },
  {
    agent: "kiro-cli",
    display: "Kiro CLI",
    dir: path.join(HOME, ".kiro", "skills"),
    canonical: false,
    defaultDistribute: false,
  },
  {
    agent: "opencode",
    display: "OpenCode",
    dir: path.join(HOME, ".config", "opencode", "skills"),
    canonical: false,
    defaultDistribute: false,
  },
  {
    agent: "antigravity",
    display: "Antigravity",
    dir: path.join(HOME, ".gemini", "antigravity", "skills"),
    canonical: false,
    defaultDistribute: false,
  },
  {
    agent: "openclaw",
    display: "OpenClaw",
    dir: path.join(HOME, ".openclaw", "skills"),
    canonical: false,
    defaultDistribute: false,
  },
  {
    agent: "warp",
    display: "Warp",
    dir: AGENTS_SKILLS,
    canonical: true,
    defaultDistribute: false,
  },
];

export const AGENT_NAMES: ReadonlyArray<string> = AGENT_REGISTRY.map((a) => a.agent);

/** Look up one agent by id, or null when the id is not in the registry. */
export function findAgent(agent: string): AgentDef | null {
  return AGENT_REGISTRY.find((a) => a.agent === agent) ?? null;
}

export type AgentSetting = {
  def: AgentDef;
  /** Whether this agent gets symlinks. */
  enabled: boolean;
  /** Where that answer came from, for `agent-skills agents` to show. */
  source: "config" | "default" | "canonical";
};

/**
 * Resolved distribution setting for every known agent, in registry order.
 *
 * A canonical agent is reported as disabled with source "canonical" no matter
 * what config holds: the answer is structural, and silently honouring a `true`
 * there would try to link the store into itself.
 */
export function agentSettings(): AgentSetting[] {
  const configured = readConfig()?.agents ?? {};
  return AGENT_REGISTRY.map((def) => {
    if (def.canonical) return { def, enabled: false, source: "canonical" as const };
    const v = configured[def.agent];
    return typeof v === "boolean"
      ? { def, enabled: v, source: "config" as const }
      : { def, enabled: def.defaultDistribute, source: "default" as const };
  });
}

/** Agents that should receive per-skill symlinks. */
export function distributionTargets(): AgentDef[] {
  return agentSettings()
    .filter((s) => s.enabled)
    .map((s) => s.def);
}

/**
 * Turn distribution on or off for one agent and persist it.
 *
 * Writes through `writeConfig`, which requires a configured store — the config
 * file holds both, and rewriting it without the store path would strand the
 * machine. Callers must have resolved a store first.
 */
export function setAgentDistribution(agent: string, enabled: boolean): void {
  const cfg = readConfig();
  if (cfg === null) {
    throw new Error(
      "No config to write to. Run `agent-skills link <store>` (or `init`) first.",
    );
  }
  writeConfig({ ...cfg, agents: { ...(cfg.agents ?? {}), [agent]: enabled } });
}

/**
 * Where `<dir>/<name>` should point, relative to the link's own directory.
 *
 * Relative rather than absolute so the link keeps working if `$HOME` moves, and
 * computed rather than hardcoded because agent dirs sit at different depths:
 * `~/.claude/skills` needs `../../.agents/skills/<name>`, but
 * `~/.config/opencode/skills` needs one more `..`.
 */
export function linkTarget(dir: string, name: string): string {
  return path.relative(dir, path.join(AGENTS_SKILLS, name));
}
