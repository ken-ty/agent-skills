/**
 * Secret / machine-specific data detection, shared by every command that lets
 * content leave the store.
 *
 * `audit` uses it on staged commits; `push` uses it before uploading to the
 * Skills API. Both are exit points, so both must apply the same rules — a
 * pattern worth blocking at commit is worth blocking at upload.
 *
 * A regex sweep cannot be complete. The durable control is the scope rule:
 * project-specific material belongs in that project's .claude/skills/, not in
 * the global store. This is the backstop, not the strategy.
 */

/** Escape hatch: put this marker on a line to accept it deliberately. */
export const ALLOW = "audit-ignore";

export type Rule = { id: string; why: string; re: RegExp };

/**
 * Patterns are written so they do not match their own source text, which is
 * why the scanning files are scanned like any other.
 */
export const RULES: ReadonlyArray<Rule> = [
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

/** Paths that should never leave the store, regardless of content. */
export const FORBIDDEN_PATHS = [/(^|\/)\.env(\.|$)/, /(^|\/)id_(rsa|ed25519)$/, /\.pem$/, /\.p12$/];

export type Finding = { file: string; line: number; rule: Rule; match: string };

/** Never print a match in full — the report itself would become a leak. */
export function redact(s: string): string {
  return s.length <= 8 ? "***" : `${s.slice(0, 4)}***${s.slice(-2)} (${s.length} chars)`;
}

/** Scan one file's text. Binary content has no lines worth reporting. */
export function scan(file: string, text: string): Finding[] {
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

/** True when this path must never be shipped, whatever it contains. */
export const isForbiddenPath = (file: string): boolean =>
  FORBIDDEN_PATHS.some((re) => re.test(file));

/** Render findings the same way everywhere, with matches redacted. */
export function reportFindings(findings: ReadonlyArray<Finding>): void {
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.rule.id}] ${f.rule.why}`);
    console.error(`    matched: ${redact(f.match)}\n`);
  }
}
