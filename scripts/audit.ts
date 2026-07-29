/**
 * Scan what is about to be committed for secrets and machine/project-specific
 * data. Wired in as a pre-commit hook (see hooks/pre-commit).
 *
 * Why this repo needs it: skills/ is symlinked into ~/.agents/skills, which
 * every agent reads on every session. Anything that lands in a skill body is
 * injected into unrelated projects' context from then on. Making the repo
 * private does nothing about that — the leak path is the agent, not GitHub.
 *
 * Scope note: `kind: remote` skills are gitignored, so they never reach a
 * commit and are out of scope automatically. What this scans is exactly the
 * git-backed surface: own + vendored skills, plus the repo's own files.
 *
 *   node scripts/run.js audit          staged content (what the hook runs)
 *   node scripts/run.js audit --all    every tracked file
 *
 * A regex sweep cannot be complete. The durable control is the scope rule:
 * project-specific material belongs in that project's .claude/skills/, not in
 * this global store. This is the backstop, not the strategy.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runGitleaks } from "./lib/gitleaks.ts";
import { gitToplevel } from "./lib/paths.ts";
import {
  ALLOW,
  type Finding,
  isForbiddenPath,
  reportFindings,
  scan,
} from "./lib/secrets.ts";

/**
 * Audit the git repo it is invoked in, not a configured store. As a store's
 * pre-commit hook it runs with cwd inside that store, so the toplevel is the
 * store being committed to — correct even with several stores on one machine,
 * and it needs no store config to run.
 */
const REPO_ROOT = gitToplevel() ?? process.cwd();

function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

const all = process.argv.includes("--all");

/**
 * `-z` is not a detail: without it git applies `core.quotePath` and prints a
 * non-ASCII path as `"skills/\346\227\245..."` — quoted and octal-escaped. That
 * string does not resolve as a pathspec, so `git show :<file>` fails and the
 * file drops out of the scan. A skill named in Japanese would then carry a
 * secret straight past the hook. NUL-separated output is never rewritten.
 */
function targets(): string[] {
  const r = all
    ? git(["ls-files", "-z"])
    : git(["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"]);
  return r.out.split("\0").filter((l) => l !== "");
}

/** Staged content, not working-tree content — partial staging must be honoured. */
function contentOf(file: string): string | null {
  if (all) {
    try {
      return fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    } catch {
      return null;
    }
  }
  const r = git(["show", `:${file}`]);
  return r.ok ? r.out : null;
}

function main(): void {
  const files = targets();
  if (files.length === 0) {
    console.log(all ? "audit: no tracked files" : "audit: nothing staged");
    return;
  }

  const findings: Finding[] = [];
  const forbidden: string[] = [];
  const unreadable: string[] = [];
  const examined = new Map<string, string>();

  for (const file of files) {
    if (isForbiddenPath(file)) {
      forbidden.push(file);
      continue;
    }
    const text = contentOf(file);
    // "could not read" is not "no secrets found". Silently skipping would let
    // the summary below call an unexamined file clean.
    if (text === null) {
      unreadable.push(file);
      continue;
    }
    examined.set(file, text);
    findings.push(...scan(file, text));
  }

  // Second opinion, only if gitleaks happens to be installed. Handed the same
  // content that was just scanned, so both scanners judge identical bytes.
  const leaks = runGitleaks(examined);
  if (leaks.kind === "ran") findings.push(...leaks.findings);

  // Say which scanners looked, always. "clean" from one scanner and "clean"
  // from two are different claims, and the reader cannot tell them apart from
  // the file count alone.
  const coverage =
    leaks.kind === "ran"
      ? "built-in + gitleaks"
      : leaks.kind === "absent"
        ? "built-in only — gitleaks not on PATH"
        : `built-in only — gitleaks failed: ${leaks.reason}`;

  const problems = forbidden.length + findings.length + unreadable.length;
  if (problems === 0) {
    console.log(`audit: ${files.length} file(s) clean (${coverage})`);
    return;
  }

  console.error(`audit: BLOCKED — ${problems} problem(s) (${coverage})\n`);

  for (const file of forbidden) {
    console.error(`  ${file}`);
    console.error("    this kind of file must never be committed\n");
  }
  for (const file of unreadable) {
    console.error(`  ${file}`);
    console.error("    could not be read — audit cannot clear what it cannot see\n");
  }
  reportFindings(findings);

  console.error(`If a hit is a false positive, add \`${ALLOW}\` to that line.`);
  console.error("If it is real: do NOT just amend — a committed secret stays in history.");
  console.error("Project-specific content belongs in that project's .claude/skills/, not here.");
  process.exitCode = 1;
}

main();
