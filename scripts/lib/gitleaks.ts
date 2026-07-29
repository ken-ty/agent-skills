/**
 * Optional second opinion from gitleaks.
 *
 * The built-in sweep in secrets.ts is a short hand-written rule list. gitleaks
 * carries a far larger one, so running both catches more. But this repo's only
 * hard requirement is Node >= 22.18, and that is a feature, not an accident —
 * so gitleaks is used when it happens to be on PATH and is never required.
 *
 * Three rules follow from "never required":
 *
 *  - absent is not a problem. It is reported, so a clean audit never implies
 *    gitleaks looked, but it does not affect the exit code.
 *  - a broken invocation is not a problem either. If it were, a gitleaks that
 *    fails to start would block every commit — exactly the hard dependency this
 *    is supposed to avoid. The built-in sweep still ran, so the commit is no
 *    less examined than it was before gitleaks existed.
 *  - what gitleaks *finds* is a problem, ranked with the built-in findings.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALLOW, type Finding } from "./secrets.ts";

export type GitleaksResult =
  | { kind: "absent" }
  | { kind: "failed"; reason: string }
  | { kind: "ran"; findings: Finding[] };

/** One entry of gitleaks' JSON report. Only the fields used are declared. */
type Leak = {
  RuleID?: unknown;
  Description?: unknown;
  File?: unknown;
  StartLine?: unknown;
  Secret?: unknown;
  Match?: unknown;
};

const str = (v: unknown, fallback: string): string =>
  typeof v === "string" && v !== "" ? v : fallback;

// Probes are memoised because push calls this once per skill: without it, a
// push of a dozen skills pays three extra process spawns each to re-learn the
// same two facts about the same binary.
let onPathCache: boolean | null = null;
let modernCache: boolean | null = null;

function onPath(): boolean {
  if (onPathCache === null) {
    const r = spawnSync("gitleaks", ["version"], { encoding: "utf8" });
    onPathCache = r.error === undefined && r.status === 0;
  }
  return onPathCache;
}

/**
 * gitleaks 8.19 renamed `detect --no-git --source <dir>` to `dir <dir>`. Both
 * spellings are still in the wild, so probe rather than pin a version: an
 * unknown subcommand exits non-zero and costs one cheap spawn to rule out.
 */
function scanArgs(dir: string, report: string): string[] {
  const common = [
    "--report-format",
    "json",
    "--report-path",
    report,
    // Findings are read from the report, not the exit code. Left at its
    // default, a hit would be indistinguishable from a failed invocation.
    "--exit-code",
    "0",
    "--no-banner",
  ];
  if (modernCache === null) {
    modernCache = spawnSync("gitleaks", ["dir", "--help"], { encoding: "utf8" }).status === 0;
  }
  return modernCache
    ? ["dir", dir, ...common]
    : ["detect", "--no-git", "--source", dir, ...common];
}

/**
 * Scan exactly the content the caller already decided to examine, by writing it
 * to a scratch directory under the same relative paths.
 *
 * Pointing gitleaks at the repo instead would scan the wrong thing: audit reads
 * *staged* blobs, so a secret staged out of a dirty file, or a file whose
 * working-tree copy is clean, would be judged on the wrong bytes. Materialising
 * keeps both scanners on one identical input, which is also what makes their
 * findings safe to merge into a single report.
 */
export function runGitleaks(files: ReadonlyMap<string, string>): GitleaksResult {
  if (files.size === 0) return { kind: "ran", findings: [] };
  if (!onPath()) return { kind: "absent" };

  let dir: string | null = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-skills-audit-"));
    for (const [file, text] of files) {
      const dest = path.join(dir, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, text);
    }

    const report = path.join(dir, "gitleaks-report.json");
    const r = spawnSync("gitleaks", scanArgs(dir, report), { encoding: "utf8" });
    if (r.error !== undefined) return { kind: "failed", reason: r.error.message };
    if (r.status !== 0) {
      const why = (r.stderr ?? "").trim().split("\n").pop() ?? `exit ${r.status}`;
      return { kind: "failed", reason: why };
    }

    // No report file means no findings — gitleaks only writes one when it has
    // something to write.
    if (!fs.existsSync(report)) return { kind: "ran", findings: [] };
    const parsed: unknown = JSON.parse(fs.readFileSync(report, "utf8"));
    if (!Array.isArray(parsed)) return { kind: "failed", reason: "report was not a JSON array" };

    const findings: Finding[] = [];
    for (const leak of parsed as Leak[]) {
      const file = str(leak.File, "");
      // The report path lives in the scratch dir too; it is not scanned input.
      if (file === "" || file === path.basename(report)) continue;
      const line = typeof leak.StartLine === "number" ? leak.StartLine : 0;
      // The escape hatch has to cover gitleaks too. Without this, a line marked
      // `audit-ignore` would pass the built-in sweep and still block the commit
      // from the other scanner, which reads as the marker being broken.
      const source = files.get(file) ?? "";
      if ((source.split("\n")[line - 1] ?? "").includes(ALLOW)) continue;
      const id = str(leak.RuleID, "unknown");
      findings.push({
        file,
        line,
        rule: { id: `gitleaks:${id}`, why: str(leak.Description, id) },
        match: str(leak.Secret, str(leak.Match, "")),
      });
    }
    return { kind: "ran", findings };
  } catch (e) {
    return { kind: "failed", reason: e instanceof Error ? e.message : String(e) };
  } finally {
    if (dir !== null) fs.rmSync(dir, { recursive: true, force: true });
  }
}
