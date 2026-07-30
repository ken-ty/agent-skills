/**
 * Hand one skill to someone who has neither this tool nor the store.
 *
 *   agent-skills share <name>              temporary — an orphan branch that expires
 *   agent-skills share <name> --keep       permanent — lives on the share repo's default branch
 *   agent-skills share <name> --days 30    how long a temporary share is meant to last
 *
 * Pushes a copy of `skills/<name>/` to the configured share repo and prints a URL
 * that both reads in a browser and installs with `npx skills add`. The recipient
 * needs neither agent-skills nor a store; nothing in what gets pushed refers to
 * either. See the store's `share-agent-skill` skill for the surrounding procedure.
 *
 * Deliberately stateless. There is no ledger of what is currently shared: the
 * expiry of a temporary share lives in its branch name, and the list of live
 * shares is whatever the share repo reports. A local copy of that would be a
 * second set of books, and `doctor` would then have to reconcile them.
 *
 * For the same reason catalog.json is read but never written. What is being
 * shared is distribution state, not provenance — recording it there would make
 * the store depend on a surface it otherwise knows nothing about.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runGitleaks } from "./lib/gitleaks.ts";
import { type Finding, isForbiddenPath, reportFindings, scan } from "./lib/secrets.ts";
import { frontmatter, readCatalog, storeSkills, tilde } from "./lib/paths.ts";
import { CONFIG_PATH, SHARE_REPO_ENV, resolveShareRepoOrNull } from "./lib/store.ts";

const BEGIN = "<!-- managed by `agent-skills share` (do not edit) -->";
const END = "<!-- end managed -->";

type Mode = "temp" | "keep";
type Repo = { owner: string; repo: string };

const OPTS_WITH_VALUE = new Set(["--days", "--repo"]);

function parseArgs(argv: string[]): {
  flags: Set<string>;
  opts: Map<string, string>;
  rest: string[];
} {
  const flags = new Set<string>();
  const opts = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (OPTS_WITH_VALUE.has(a)) opts.set(a, argv[++i] ?? "");
    else if (a.startsWith("-")) flags.add(a);
    else rest.push(a);
  }
  return { flags, opts, rest };
}

const { flags, opts, rest } = parseArgs(process.argv.slice(2));
const dryRun = flags.has("--dry-run") || flags.has("-n");

function fail(msg: string, ...detail: string[]): never {
  console.error(`share: ${msg}`);
  for (const d of detail) console.error(`  ${d}`);
  process.exit(1);
}

/** Accepts `owner/repo`, an https URL, or an ssh remote. */
function parseRepo(spec: string): Repo | null {
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
    spec,
  );
  return m === null ? null : { owner: m[1]!, repo: m[2]! };
}

const cloneUrl = (r: Repo): string => `https://github.com/${r.owner}/${r.repo}.git`;
const webUrl = (r: Repo, ref: string, name: string): string =>
  `https://github.com/${r.owner}/${r.repo}/tree/${ref}/${name}`;

/** Run git, and stop the whole command if it fails — every step here is required. */
function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    fail(
      `git ${args.slice(0, 2).join(" ")} failed`,
      ...(r.stderr ?? "").trim().split("\n").filter(Boolean),
    );
  }
  return (r.stdout ?? "").trim();
}

/** Every file under `dir`, relative to it. Dotfiles are local bookkeeping. */
function filesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .filter((rel) => !rel.split(path.sep).some((seg) => seg.startsWith(".")))
    .sort();
}

/**
 * The same scan `audit` runs, against the files about to be published rather
 * than against staged content. Publishing is the irreversible step, so this is
 * the last place the check can still do any good.
 */
function refuseIfSecrets(dir: string, name: string): void {
  const files = filesUnder(dir);
  const examined = new Map<string, string>();
  const findings: Finding[] = [];
  const forbidden: string[] = [];

  for (const rel of files) {
    if (isForbiddenPath(rel)) {
      forbidden.push(rel);
      continue;
    }
    const text = fs.readFileSync(path.join(dir, rel), "utf8");
    examined.set(`${name}/${rel}`, text);
    findings.push(...scan(`${name}/${rel}`, text));
  }

  const leaks = runGitleaks(examined);
  if (leaks.kind === "ran") findings.push(...leaks.findings);
  const coverage =
    leaks.kind === "ran"
      ? "built-in + gitleaks"
      : leaks.kind === "absent"
        ? "built-in only — gitleaks not on PATH"
        : `built-in only — gitleaks failed: ${leaks.reason}`;

  if (forbidden.length === 0 && findings.length === 0) {
    console.log(`  audit  ${files.length} file(s) clean (${coverage})`);
    return;
  }

  console.error(`share: REFUSED — ${forbidden.length + findings.length} problem(s) (${coverage})\n`);
  for (const f of forbidden) console.error(`  ${name}/${f}\n    this kind of file must never leave the store\n`);
  reportFindings(findings);
  console.error("Publishing cannot be undone. Fix the skill, then share it.");
  process.exit(1);
}

/**
 * Only `own` skills are ours to hand out. A remote one the recipient can fetch
 * from its own source — passing on a copy just hides where it came from — and a
 * vendored one carries someone else's redistribution terms.
 */
function refuseIfNotOurs(name: string, force: boolean): void {
  const entry = readCatalog()?.skills?.[name];
  if (entry === undefined) {
    fail(
      `${name} has no catalog.json entry`,
      "Its origin is unrecorded, so there is nothing to stand behind when sharing it.",
      "Record it first — `agent-skills doctor` names the fix.",
    );
  }
  if (entry.kind === "remote") {
    const src = entry.refs?.[0];
    fail(
      `${name} is \`kind: remote\` — do not pass on a copy`,
      `Send the recipient its own source instead${src === undefined ? "" : `: ${src}`}`,
    );
  }
  if (entry.kind === "vendored" && !force) {
    fail(
      `${name} is \`kind: vendored\` — redistribution depends on its licence`,
      `origin: ${entry.origin ?? "(none recorded)"}`,
      ...(entry.note === undefined ? [] : [`note: ${entry.note}`]),
      "Check the terms yourself, then re-run with --force if they allow it.",
    );
  }
  if (entry.kind === "vendored") {
    console.log(`  warn   ${name} is vendored — sharing anyway because of --force`);
  }
}

/** The README that makes a bare URL readable: GitHub renders it for the directory. */
function skillReadme(name: string, desc: string, url: string, expiry: string | null): string {
  const shareLine =
    expiry === null
      ? [
          "- 共有形態: **恒久共有**。この URL が常に最新",
          "- 元の store で更新したら、ここにも反映される",
        ]
      : [
          `- 共有形態: **一時共有**。**${expiry} ごろに削除する**`,
          "- 更新は来ない。必要なら手元に控えておくこと",
        ];

  return `# ${name}

${desc}

## 入れる

\`\`\`bash
npx skills add ${url}
\`\`\`

手で入れるなら、このディレクトリごと \`.claude/skills/${name}/\` にコピーする
（Claude Code の場合）。読むだけなら [SKILL.md](./SKILL.md) を開けばよい。

## これは何か

[agent-skills](https://github.com/ken-ty/agent-skills) の store にある \`kind: own\` の
スキルを 1 本切り出したもの。

${shareLine.join("\n")}

> この README は共有時の自動生成物で、元の store には無い。\`SKILL.md\` が本体。
`;
}

/**
 * Rebuild the index on the share repo's README from what is actually on the
 * branch, rather than editing a row in place. Generating it means the listing
 * cannot drift from the directories, and there is no table to parse.
 */
function rewriteIndex(repoDir: string): void {
  const readme = path.join(repoDir, "README.md");
  const names = fs
    .readdirSync(repoDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();

  const rows = names.map((n) => {
    const md = path.join(repoDir, n, "SKILL.md");
    const desc = fs.existsSync(md) ? (frontmatter(fs.readFileSync(md, "utf8")).description ?? "") : "";
    // One cell, one line: a pipe or newline from the description would break the row.
    const cell = desc.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
    return `| [${n}](./${n}) | ${cell} |`;
  });

  const block = [
    BEGIN,
    "",
    "| スキル | 説明 |",
    "| --- | --- |",
    ...(rows.length > 0 ? rows : ["| — | まだ何も置いていない |"]),
    "",
    END,
  ].join("\n");

  const existing = fs.existsSync(readme) ? fs.readFileSync(readme, "utf8") : "";
  const start = existing.indexOf(BEGIN);
  const stop = existing.indexOf(END);
  const next =
    start !== -1 && stop !== -1 && stop > start
      ? existing.slice(0, start) + block + existing.slice(stop + END.length)
      : existing.trimEnd() === ""
        ? `${block}\n`
        : `${existing.trimEnd()}\n\n${block}\n`;

  if (next !== existing) fs.writeFileSync(readme, next);
}

/** Copy the skill body, leaving dotfiles behind. */
function copySkill(from: string, to: string): void {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => !path.basename(src).startsWith("."),
  });
}

function usage(): never {
  console.error("usage: agent-skills share <name> [--keep] [--days <n>] [--repo <owner/repo>] [--force] [--dry-run]");
  console.error("");
  console.error("  (default)   temporary share on an orphan branch that carries its expiry");
  console.error("  --keep      permanent share on the share repo's default branch");
  process.exit(1);
}

function main(): void {
  const name = rest[0];
  if (name === undefined || rest.length > 1) usage();

  const mode: Mode = flags.has("--keep") ? "keep" : "temp";
  const days = Number(opts.get("--days") ?? "7");
  if (!Number.isInteger(days) || days < 1) fail("--days must be a positive whole number");

  const spec = opts.get("--repo") ?? resolveShareRepoOrNull();
  if (spec === null) {
    fail(
      "no share repo configured",
      `Add \`"shareRepo": "<owner>/<repo>"\` to ${tilde(CONFIG_PATH)},`,
      `or set ${SHARE_REPO_ENV}, or pass --repo <owner>/<repo>.`,
      "It must be a repo you can push to; make one first if you have none.",
    );
  }
  const repo = parseRepo(spec);
  if (repo === null) fail(`could not read ${JSON.stringify(spec)} as a GitHub repo`, "Expected owner/repo.");

  const src = path.join(storeSkills(), name);
  if (!fs.existsSync(path.join(src, "SKILL.md"))) {
    fail(`${tilde(src)}/SKILL.md does not exist`, "`agent-skills list` shows what is in the store.");
  }

  console.log(`share: ${name} -> ${repo.owner}/${repo.repo} (${mode})\n`);
  refuseIfNotOurs(name, flags.has("--force"));
  refuseIfSecrets(src, name);

  const desc = frontmatter(fs.readFileSync(path.join(src, "SKILL.md"), "utf8")).description ?? "";
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-skills-share-"));

  try {
    let ref: string;
    let expiry: string | null = null;

    if (mode === "temp") {
      // UTC, so an expiry set late in the day can read as one day early. The
      // date is a human-facing intent ("delete around then"), not a deadline
      // anything enforces, so that is close enough.
      const until = new Date(Date.now() + days * 86_400_000);
      expiry = until.toISOString().slice(0, 10);
      ref = `share-${name}-${expiry.replace(/-/g, "")}`;

      // No clone: an orphan share has no history to start from, and building it
      // in an empty repo is what makes it independent of every other share.
      git(work, ["init", "-q", "-b", ref]);
      copySkill(src, path.join(work, name));
    } else {
      git(work, ["clone", "-q", "--depth", "1", cloneUrl(repo), "."]);
      ref = git(work, ["rev-parse", "--abbrev-ref", "HEAD"]);
      copySkill(src, path.join(work, name));
      rewriteIndex(work);
    }

    const url = webUrl(repo, ref, name);
    fs.writeFileSync(path.join(work, name, "README.md"), skillReadme(name, desc, url, expiry));

    console.log(`  branch ${ref}${expiry === null ? "" : `  (delete around ${expiry})`}`);
    for (const f of filesUnder(path.join(work, name))) console.log(`  file   ${name}/${f}`);

    if (dryRun) {
      console.log(`\nDry run — nothing pushed. Would publish:\n  ${url}`);
      return;
    }

    git(work, ["add", "-A"]);
    const staged = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: work });
    if (staged.status === 0) {
      console.log(`\nAlready up to date:\n  ${url}`);
      return;
    }

    const subject =
      mode === "temp" ? `share: ${name} (until ${expiry})` : `share: keep ${name}`;
    git(work, ["commit", "-q", "-m", subject]);
    if (mode === "temp") git(work, ["remote", "add", "origin", cloneUrl(repo)]);
    git(work, ["push", "-q", "origin", `HEAD:refs/heads/${ref}`]);

    console.log(`\nPublished:\n  ${url}\n`);
    console.log("Send them this:");
    console.log(`  npx skills add ${url}`);
    if (expiry !== null) {
      console.log(`\nExpires ${expiry} — the date is only in the branch name, so delete it yourself:`);
      console.log(`  gh api -X DELETE repos/${repo.owner}/${repo.repo}/git/refs/heads/${ref}`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main();
