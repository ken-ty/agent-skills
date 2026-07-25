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

/**
 * Audit the git repo it is invoked in, not a configured store. As a store's
 * pre-commit hook it runs with cwd inside that store, so the toplevel is the
 * store being committed to — correct even with several stores on one machine,
 * and it needs no store config to run.
 */
function gitToplevel(): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const top = (r.stdout ?? "").trim();
  return r.status === 0 && top !== "" ? top : process.cwd();
}

const REPO_ROOT = gitToplevel();

/** Escape hatch: put this marker on a line to accept it deliberately. */
const ALLOW = "audit-ignore";

type Rule = { id: string; why: string; re: RegExp };

/**
 * Patterns are written so they do not match their own source text, which is
 * why this file itself is scanned like any other.
 */
const RULES: ReadonlyArray<Rule> = [
  {
    id: "private-key",
    why: "private key block",
    re: /-----BEGIN[A-Z ]*PRIVATE KEY-----/,
  },
  {
    id: "github-token",
    why: "GitHub token",
    re: /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  },
  {
    id: "aws-access-key",
    why: "AWS access key id",
    re: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: "llm-api-key",
    why: "Anthropic / OpenAI style API key",
    re: /\bsk-(ant-)?[A-Za-z0-9_-]{24,}/,
  },
  {
    id: "slack-token",
    why: "Slack token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  },
  {
    id: "google-api-key",
    why: "Google API key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: "secret-assignment",
    why: "credential assigned to a variable",
    re: /\b(api[_-]?key|secret|password|passwd|credential|access[_-]?token)\b["'\s]*[:=]["'\s]*[A-Za-z0-9_\-/+]{16,}/i,
  },
  {
    id: "absolute-home-path",
    why: "machine-specific absolute path (use ~ instead)",
    re: /\/(?:Users|home)\/[A-Za-z0-9._-]+\//,
  },
];

/** Paths that should never be committed at all, regardless of content. */
const FORBIDDEN_PATHS = [/(^|\/)\.env(\.|$)/, /(^|\/)id_(rsa|ed25519)$/, /\.pem$/, /\.p12$/];

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

/** Never print a match in full — the report itself would become a leak. */
function redact(s: string): string {
  return s.length <= 8 ? "***" : `${s.slice(0, 4)}***${s.slice(-2)} (${s.length} chars)`;
}

type Finding = { file: string; line: number; rule: Rule; match: string };

function scan(file: string, text: string): Finding[] {
  // Binary files have no lines worth reporting and blow up the output.
  if (text.includes("\0")) return [];

  const out: Finding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes(ALLOW)) continue;
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (m !== null) out.push({ file, line: i + 1, rule, match: m[0] });
    }
  }
  return out;
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

  for (const file of files) {
    if (FORBIDDEN_PATHS.some((re) => re.test(file))) {
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
    findings.push(...scan(file, text));
  }

  const problems = forbidden.length + findings.length + unreadable.length;
  if (problems === 0) {
    console.log(`audit: ${files.length} file(s) clean`);
    return;
  }

  console.error(`audit: BLOCKED — ${problems} problem(s)\n`);

  for (const file of forbidden) {
    console.error(`  ${file}`);
    console.error("    this kind of file must never be committed\n");
  }
  for (const file of unreadable) {
    console.error(`  ${file}`);
    console.error("    could not be read — audit cannot clear what it cannot see\n");
  }
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.rule.id}] ${f.rule.why}`);
    console.error(`    matched: ${redact(f.match)}\n`);
  }

  console.error("If a hit is a false positive, add `audit-ignore` to that line.");
  console.error("If it is real: do NOT just amend — a committed secret stays in history.");
  console.error("Project-specific content belongs in that project's .claude/skills/, not here.");
  process.exitCode = 1;
}

main();
