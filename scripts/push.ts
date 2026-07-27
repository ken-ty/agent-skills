/**
 * Upload store skills to the Anthropic Skills API (the workspace surface).
 *
 *   agent-skills push [name...] [--dry-run] [--include-remote]
 *
 * Skills do NOT sync across surfaces. This command covers exactly one of the
 * three:
 *
 *   local FS  ~/.claude/skills   <- symlinked to the store already (automatic)
 *   claude.ai personal skills    <- Web UI upload only; NO API exists (manual)
 *   API workspace skills         <- this command
 *
 * So a successful push does not put anything into claude.ai. That asymmetry is
 * an upstream constraint, not a design choice, which is why it is restated in
 * the output rather than left to the README.
 * https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
 *
 * Everything up to the request — selection, validation, secret scanning — runs
 * without an API key so `--dry-run` is fully meaningful before you have one.
 */
import fs from "node:fs";
import path from "node:path";
import {
  type Catalog,
  namesOfKind,
  presentSkillNames,
  readCatalog,
  storeSkills,
  tilde,
} from "./lib/paths.ts";
import { type Finding, isForbiddenPath, reportFindings, scan } from "./lib/secrets.ts";

const API_BASE = "https://api.anthropic.com/v1/skills";
const API_VERSION = "2023-06-01";
const BETA = "skills-2025-10-02";
/** Documented per-skill upload ceiling. */
const MAX_BYTES = 30 * 1024 * 1024;

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run") || argv.includes("-n");
const includeRemote = argv.includes("--include-remote");
const wanted = argv.filter((a) => !a.startsWith("-"));

/**
 * Handled before anything else: unrecognised flags are otherwise dropped by the
 * filter above, so `push --help` would fall through to a real upload of every
 * skill. Asking for help must never send anything.
 */
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`usage: agent-skills push [name...] [--dry-run] [--include-remote]

Uploads store skills to the Anthropic Skills API (the workspace surface).
With no names, pushes the git-backed skills: catalog kind \`own\` and \`vendored\`.

  name...            push only these skills
  --dry-run, -n      show what would be sent; makes no request
  --include-remote   also push kind \`remote\` (skipped by default — upstream publishes those)

Requires ANTHROPIC_API_KEY. Everything except the request itself — selection,
validation, secret scanning — runs without one, so --dry-run works before you
have a key.

Skills do not sync between surfaces. This command only reaches the API
workspace: claude.ai has no API, so upload there by hand from its web UI.`);
  process.exit(0);
}

type SkillFile = { abs: string; rel: string; size: number };
type Payload = { dir: string; apiName: string; files: SkillFile[]; bytes: number };

/**
 * The API keys a skill by the `name` in its SKILL.md frontmatter, and requires
 * every uploaded path to sit under a top-level dir of that same name. Directory
 * name and frontmatter name can disagree in the store (unity-mcp-skill declares
 * `unity-mcp-orchestrator`), so the frontmatter always wins here — sending the
 * directory name would be rejected.
 */
function frontmatterName(skillMd: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (fm === null) return null;
  const line = /^name:\s*(.+?)\s*$/m.exec(fm[1] ?? "");
  return line?.[1]?.replace(/^["']|["']$/g, "") ?? null;
}

/** Every file under a skill dir, as paths relative to that dir. */
function walk(dir: string, prefix = ""): SkillFile[] {
  const out: SkillFile[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    // Dotfiles are local bookkeeping (.DS_Store, sync markers), not skill content.
    if (e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(abs, rel));
    else if (e.isFile()) out.push({ abs, rel, size: fs.statSync(abs).size });
  }
  return out;
}

/** Which skills to push: git-backed ones by default, or exactly what was named. */
function selectNames(catalog: Catalog | null): string[] {
  const present = new Set(presentSkillNames());
  if (wanted.length > 0) {
    const missing = wanted.filter((n) => !present.has(n));
    if (missing.length > 0) {
      console.error(`push: not in the store: ${missing.join(", ")}`);
      process.exitCode = 1;
      return [];
    }
    return wanted;
  }
  // `remote` skills are published by their upstream already, so re-uploading
  // them under this workspace is duplication unless explicitly asked for.
  const kinds = includeRemote
    ? ["own", "vendored", "remote"]
    : ["own", "vendored"];
  return kinds
    .flatMap((k) => namesOfKind(catalog, k as "own" | "vendored" | "remote"))
    .filter((n) => present.has(n))
    .sort();
}

/** Read, validate and secret-scan one skill. Returns null when unusable. */
function preparePayload(name: string): Payload | null {
  const dir = path.join(storeSkills(), name);
  const skillMd = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillMd)) {
    console.error(`  ${name}: no SKILL.md — the API requires one at the root`);
    return null;
  }

  const apiName = frontmatterName(fs.readFileSync(skillMd, "utf8"));
  if (apiName === null) {
    console.error(`  ${name}: SKILL.md has no \`name:\` in its frontmatter`);
    return null;
  }

  const files = walk(dir);
  const bytes = files.reduce((n, f) => n + f.size, 0);
  if (bytes > MAX_BYTES) {
    console.error(`  ${name}: ${(bytes / 1024 / 1024).toFixed(1)} MB exceeds the 30 MB limit`);
    return null;
  }

  // Uploading is an exit point from the store, so it gets the same guard as a
  // commit — stricter, if anything, because this leaves the machine entirely.
  const findings: Finding[] = [];
  const forbidden: string[] = [];
  const unreadable: string[] = [];
  for (const f of files) {
    if (isForbiddenPath(f.rel)) {
      forbidden.push(f.rel);
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(f.abs, "utf8");
    } catch {
      // "could not read" is not "no secrets found", and this file would still
      // be in the upload. Skipping it silently would ship something unexamined.
      unreadable.push(f.rel);
      continue;
    }
    findings.push(...scan(`${name}/${f.rel}`, text));
  }
  if (forbidden.length > 0 || unreadable.length > 0 || findings.length > 0) {
    console.error(`  ${name}: BLOCKED — will not upload`);
    for (const p of forbidden) console.error(`    ${p}: this kind of file must never be shipped`);
    for (const p of unreadable) console.error(`    ${p}: could not be read — cannot clear what it cannot see`);
    reportFindings(findings);
    return null;
  }

  return { dir, apiName, files, bytes };
}

// ---------------------------------------------------------------------------
// API layer. Nothing above this line needs a key or a network.
// ---------------------------------------------------------------------------

function apiKey(): string | null {
  const k = process.env.ANTHROPIC_API_KEY;
  return k !== undefined && k.trim() !== "" ? k : null;
}

const headers = (key: string): Record<string, string> => ({
  "x-api-key": key,
  "anthropic-version": API_VERSION,
  "anthropic-beta": BETA,
});

type RemoteSkill = { id: string; display_title: string; latest_version?: string };

/** Existing custom skills in the workspace, keyed by display title. */
async function listRemote(key: string): Promise<Map<string, RemoteSkill>> {
  const res = await fetch(`${API_BASE}?source=custom`, { headers: headers(key) });
  if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { data?: RemoteSkill[] };
  return new Map((body.data ?? []).map((s) => [s.display_title, s]));
}

/**
 * Build the multipart body. Each part is `files[]` and its filename carries the
 * skill-name directory prefix the API expects (`<name>/SKILL.md`).
 */
function formFor(p: Payload): FormData {
  const form = new FormData();
  for (const f of p.files) {
    const blob = new Blob([fs.readFileSync(f.abs)]);
    form.append("files[]", blob, `${p.apiName}/${f.rel}`);
  }
  return form;
}

async function upload(key: string, p: Payload, existing: RemoteSkill | undefined): Promise<string> {
  const url = existing === undefined ? API_BASE : `${API_BASE}/${existing.id}/versions`;
  const res = await fetch(url, { method: "POST", headers: headers(key), body: formFor(p) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = (await res.json()) as { id?: string; version?: string };
  return existing === undefined
    ? `created ${body.id ?? "?"}`
    : `new version ${body.version ?? "?"} of ${existing.id}`;
}

async function main(): Promise<void> {
  const catalog = readCatalog();
  const names = selectNames(catalog);
  if (names.length === 0) {
    if (process.exitCode !== 1) console.log("push: nothing to push");
    return;
  }

  console.log(`push: ${names.length} skill(s) from ${tilde(storeSkills())}\n`);

  const payloads = new Map<string, Payload>();
  for (const name of names) {
    const p = preparePayload(name);
    if (p === null) {
      process.exitCode = 1;
      continue;
    }
    payloads.set(name, p);
  }

  const key = apiKey();

  if (dryRun) {
    for (const [name, p] of payloads) {
      console.log(`  ${name} -> ${p.apiName}/  ${p.files.length} file(s), ${(p.bytes / 1024).toFixed(1)} KB`);
    }
    console.log(
      `\nDry run — nothing sent.${key === null ? " (ANTHROPIC_API_KEY is not set)" : ""}`,
    );
    console.log("Note: this targets the API workspace. claude.ai is a separate surface — upload there by hand.");
    return;
  }

  if (key === null) {
    console.error("push: ANTHROPIC_API_KEY is not set.\n");
    console.error("  export ANTHROPIC_API_KEY=...   # then re-run");
    console.error("  agent-skills push --dry-run    # works without a key");
    process.exitCode = 1;
    return;
  }

  let remote: Map<string, RemoteSkill>;
  try {
    remote = await listRemote(key);
  } catch (e) {
    console.error(`push: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  for (const [name, p] of payloads) {
    try {
      // Matching on the API's own title keeps re-pushes as versions rather than
      // piling up duplicate skills.
      const done = await upload(key, p, remote.get(p.apiName));
      console.log(`  ${name}: ${done}`);
    } catch (e) {
      console.error(`  ${name}: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }

  console.log("\nPushed to the API workspace. claude.ai is a separate surface with no API —");
  console.log("upload there by hand if you want these skills in the web/desktop app.");
}

await main();
