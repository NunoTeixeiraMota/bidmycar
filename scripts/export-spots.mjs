/**
 * Writes the spots as they currently stand in the database back into
 * src/config/car.ts.
 *
 *   node scripts/export-spots.mjs           rewrite the config
 *   node scripts/export-spots.mjs --dry     print it and change nothing
 *
 * WHY THIS EXISTS
 *
 * Dragging a spot in /admin writes an override onto a database row. That is the
 * right place for it while you are arranging the car, but it is the wrong place
 * for it at deploy time: a fresh environment gets a fresh database, seeded from
 * src/config/car.ts, and knows nothing about what you moved on your laptop.
 *
 * This closes that gap. Arrange the car in /admin, run this, commit the config,
 * and every future deploy opens with the board you actually built.
 *
 * The array between the SPOTS:START and SPOTS:END markers is replaced wholesale,
 * so anything you write inside those markers by hand is expected to be
 * disposable. Everything else in the file is left exactly as it was.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import DatabaseCtor from "better-sqlite3";

// Type stripping emits a performance advisory for every .ts file it loads; it
// is noise in front of a results table. Node keeps no public "unwarn" hook, so
// the default printer is replaced by one that filters this single code.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.code !== "MODULE_TYPELESS_PACKAGE_JSON") console.error(warning.stack);
});

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(PROJECT_ROOT, "src", "config", "car.ts");
const DRY = process.argv.includes("--dry");
const RESPAWNED = process.env.__EXPORT_TYPE_STRIPPING === "1";

const START = "/* SPOTS:START";
const END = "/* SPOTS:END */";

/* ------------------------------------------------------------------ *
 * Loading the TypeScript config
 * ------------------------------------------------------------------ */

async function loadConfig() {
  try {
    return await import(new URL("../src/config/car.ts", import.meta.url).href);
  } catch (error) {
    // Node 22.6 to 22.17 can strip types but only when asked, and a runtime
    // flag cannot be added to a process that has already started.
    if (RESPAWNED) throw error;

    const child = spawnSync(
      process.execPath,
      ["--experimental-strip-types", ...process.argv.slice(1)],
      { stdio: "inherit", env: { ...process.env, __EXPORT_TYPE_STRIPPING: "1" } },
    );
    if (child.status === 0) process.exit(0);

    console.error(
      "\nexport-spots: could not load src/config/car.ts.\n" +
        "Node must be able to run TypeScript directly: use Node 22.6 or newer.\n" +
        `This is Node ${process.version}.\n`,
    );
    process.exit(1);
  }
}

const { SPOTS, CAR } = await loadConfig();
const shipped = new Map(SPOTS.map((spot) => [spot.key, spot]));

/* ------------------------------------------------------------------ *
 * Reading the board
 * ------------------------------------------------------------------ */

const dbPath = process.env.AUCTION_DB_PATH ?? join(PROJECT_ROOT, "data", "auction.db");

let db;
try {
  db = new DatabaseCtor(dbPath, { readonly: true, fileMustExist: true });
} catch {
  console.error(`\nexport-spots: no database at ${dbPath}. Run \`npm run seed\` first.\n`);
  process.exit(1);
}

const rows = db
  .prepare(
    `SELECT key, name, panel, blurb, x, y, w, h, shape, difficulty
       FROM spots
      ORDER BY (x IS NULL), x DESC, key ASC`,
  )
  .all();

db.close();

if (rows.length === 0) {
  console.error("\nexport-spots: the database has no spots. Nothing to write.\n");
  process.exit(1);
}

/**
 * A row carries an override only once it has been dragged. Where it has not,
 * the shipped survey is still the truth, so that is what gets written back:
 * exporting must never turn an un-dragged spot into a default box.
 */
function resolve(row) {
  const base = shipped.get(row.key);
  const complete = row.x !== null && row.y !== null && row.w !== null && row.h !== null;

  if (!complete && !base) {
    console.error(
      `\nexport-spots: ${row.key} has neither a box in the database nor an entry in the ` +
        "config, so there is nothing to write for it. Give it a position in /admin.\n",
    );
    process.exit(1);
  }

  return {
    key: row.key,
    name: row.name,
    panel: row.panel,
    blurb: row.blurb || base?.blurb || "",
    x: complete ? row.x : base.x,
    y: complete ? row.y : base.y,
    w: complete ? row.w : base.w,
    h: complete ? row.h : base.h,
    shape: row.shape ?? base?.shape ?? "rect",
    difficulty: row.difficulty ?? base?.difficulty ?? "mild",
  };
}

const spots = rows.map(resolve);

/* ------------------------------------------------------------------ *
 * Writing the config
 * ------------------------------------------------------------------ */

/** Source-safe double-quoted string: the blurbs contain apostrophes. */
function quote(value) {
  return JSON.stringify(String(value));
}

function num(value) {
  // Percentages are stored as floats and read back with whatever precision
  // SQLite kept; three decimals is finer than the photograph can be measured.
  return String(Math.round(value * 1000) / 1000);
}

function render(spot) {
  const lines = [
    "  {",
    `    key: ${quote(spot.key)}, name: ${quote(spot.name)}, panel: ${quote(spot.panel)},`,
  ];
  if (spot.blurb) lines.push(`    blurb: ${quote(spot.blurb)},`);
  else lines.push(`    blurb: "",`);
  lines.push(
    `    x: ${num(spot.x)}, y: ${num(spot.y)}, w: ${num(spot.w)}, h: ${num(spot.h)},` +
      ` difficulty: ${quote(spot.difficulty)},` +
      (spot.shape === "ellipse" ? ` shape: "ellipse",` : ""),
  );
  lines.push("  },");
  return lines.join("\n");
}

const block = [
  `${START} -- rewritten by \`npm run spots:export\`; edit by hand or by`,
  "   dragging in /admin, but keep these two markers where they are. */",
  "export const SPOTS: readonly SpotDefinition[] = [",
  ...spots.map(render),
  "];",
  END,
].join("\n");

const source = readFileSync(CONFIG_PATH, "utf8");
const from = source.indexOf(START);
const to = source.indexOf(END);

if (from === -1 || to === -1 || to < from) {
  console.error(
    `\nexport-spots: could not find the ${START} / ${END} markers in\n` +
      `${CONFIG_PATH}.\nThey are what tells this script which lines it may replace.\n`,
  );
  process.exit(1);
}

const next = source.slice(0, from) + block + source.slice(to + END.length);

if (DRY) {
  console.log(block);
  console.log(`\n--dry: ${CONFIG_PATH} not written.\n`);
  process.exit(0);
}

writeFileSync(CONFIG_PATH, next, "utf8");

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

const pad = (value, width) => String(value).padEnd(width);
const keyWidth = Math.max(12, ...spots.map((spot) => spot.key.length));

const added = spots.filter((spot) => !shipped.has(spot.key));
const removed = SPOTS.filter((spot) => !spots.some((kept) => kept.key === spot.key));

console.log(`\n${CAR.name}: ${spots.length} spots written to src/config/car.ts\n`);
for (const spot of spots) {
  const mark = shipped.has(spot.key) ? " " : "+";
  console.log(
    `  ${mark} ${pad(spot.key, keyWidth)}  ${pad(spot.name, 22)}` +
      `  ${num(spot.x)}, ${num(spot.y)}  ${num(spot.w)} x ${num(spot.h)}`,
  );
}
for (const spot of removed) console.log(`  - ${pad(spot.key, keyWidth)}  ${spot.name}`);

console.log(
  `\n  ${added.length} added, ${removed.length} removed, ` +
    `${spots.length - added.length} carried over.`,
);
console.log("  Commit src/config/car.ts and the next deploy seeds this board.\n");
