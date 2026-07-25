/**
 * List the skills in the canonical store, grouped by kind.
 *
 * Read-only. The catalog is the source of truth for what *should* be here and
 * why; the skills/ dir is what actually is. This surfaces both, so a skill that
 * is catalogued but missing, or present but uncatalogued, is visible at a glance
 * rather than only via `agent-skills doctor`.
 */
import {
  SKILL_KINDS,
  type Catalog,
  catalogNames,
  namesOfKind,
  presentSkillNames,
  readCatalog,
  readLock,
  storeRoot,
  thirdPartyNames,
  tilde,
} from "./lib/paths.ts";

/** One printable row. `missing` = catalogued but no body in skills/. */
type Row = { name: string; author: string; addedAt: string; missing: boolean };

function rowFor(catalog: Catalog, name: string, present: Set<string>): Row {
  const e = catalog.skills?.[name];
  return {
    name,
    author: e?.author ?? "—",
    addedAt: e?.addedAt ?? "—",
    missing: !present.has(name),
  };
}

/** Pad to width for column alignment; string length is fine (ASCII names). */
const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));

function printGroup(title: string, rows: Row[]): void {
  console.log(`${title} (${rows.length})`);
  if (rows.length === 0) {
    console.log("  —");
    console.log("");
    return;
  }
  const nameW = Math.max(...rows.map((r) => r.name.length));
  const authorW = Math.max(...rows.map((r) => r.author.length));
  for (const r of rows) {
    const flag = r.missing ? "  ⚠ missing body — `agent-skills doctor`" : "";
    console.log(`  ${pad(r.name, nameW)}  ${pad(r.author, authorW)}  ${r.addedAt}${flag}`);
  }
  console.log("");
}

const catalog = readCatalog();
const lock = readLock();
const present = new Set(presentSkillNames());

console.log(`skills in the canonical store (${tilde(storeRoot())})`);
console.log("");

if (catalog === null) {
  console.log("catalog.json not present — nothing catalogued.");
} else {
  for (const kind of SKILL_KINDS) {
    printGroup(kind, namesOfKind(catalog, kind).map((n) => rowFor(catalog, n, present)));
  }
}

// Bodies on disk that no catalog entry explains. Their kind is unknown here, so
// they sit outside the grouped view — doctor names the exact fix.
const catalogued = new Set(catalogNames(catalog));
const uncatalogued = [...present].filter((n) => !catalogued.has(n)).sort();
if (uncatalogued.length > 0) {
  console.log(`uncatalogued (${uncatalogued.length}) — present in skills/ but not in catalog.json`);
  for (const n of uncatalogued) console.log(`  ${n}`);
  console.log("");
}

const total = catalog === null ? present.size : catalogNames(catalog).length;
const remote = thirdPartyNames(lock).length;
console.log(`${total} skill(s) — ${remote} restored by \`agent-skills sync\`, the rest live in git`);
