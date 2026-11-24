// Builds data/gpu-spot-history.json from the git history of the SkyPilot
// catalog, one spot-price reading per month. Needs a local clone:
//
//   git clone --filter=blob:none --no-checkout \
//     https://github.com/skypilot-org/skypilot-catalog /tmp/skypilot-catalog
//   node scripts/backfill-gpu-history.mjs /tmp/skypilot-catalog [--full]
//
// By default it only adds the months missing after the last stored reading, so
// it is cheap to run on every deploy. --full rebuilds the whole series.
//
// Only spot is kept. The catalog's on-demand column for Google Cloud is wrong
// for long stretches (it drops below spot), so historical list prices from it
// are not trustworthy enough to chart.
import { execFileSync } from "node:child_process";
import { readData, writeData, log } from "./lib.mjs";
import { CATALOG_PROVIDERS, CATALOG_REPO, summarizeCatalog, catalogPath, monthStarts } from "./gpu-catalog.mjs";

const repo = process.argv[2];
if (!repo) {
  console.error("usage: node scripts/backfill-gpu-history.mjs <path-to-skypilot-catalog-clone>");
  process.exit(1);
}
const FULL = process.argv.includes("--full");
const START = "2022-08-01";

let existing = [];
if (!FULL) {
  try {
    existing = readData("gpu-spot-history.json").points ?? [];
  } catch { /* no file yet: build everything */ }
}
const nextMonth = (date) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
};
const FROM = existing.length ? nextMonth(existing.at(-1).date) : START;

const git = (...args) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });

/** Newest catalog version directory that holds this provider at this commit. */
function versionAt(commit, providerKey) {
  const versions = git("ls-tree", "--name-only", commit, "catalogs/")
    .split("\n").filter(Boolean).map((p) => p.split("/")[1])
    .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  for (const v of versions) {
    try {
      git("cat-file", "-e", `${commit}:${catalogPath(v, providerKey)}`);
      return v;
    } catch { /* not in this version */ }
  }
  return null;
}

const today = new Date().toISOString().slice(0, 10);
const points = [...existing];
const before = points.length;
for (const date of monthStarts(FROM, today)) {
  const commit = git("rev-list", "-1", `--before=${date}T00:00:00Z`, "HEAD").trim();
  if (!commit) continue;
  const prices = {};
  for (const p of CATALOG_PROVIDERS) {
    const v = versionAt(commit, p.key);
    if (!v) continue;
    const summary = summarizeCatalog(p.key, git("show", `${commit}:${catalogPath(v, p.key)}`));
    const spotOnly = Object.fromEntries(
      Object.entries(summary).map(([chip, v]) => [chip, { spot: v.spot, regions: v.regions }])
    );
    if (Object.keys(spotOnly).length) prices[p.key] = spotOnly;
  }
  if (!Object.keys(prices).length) continue;
  points.push({ date, commit: commit.slice(0, 12), prices });
  log(`  ${date}  ${Object.entries(prices).map(([k, s]) => `${k}:${Object.keys(s).join("/")}`).join("  ")}`);
}

writeData("gpu-spot-history.json", {
  source: `github.com/${CATALOG_REPO} (git history)`,
  note: "One spot reading per month: catalog state at 00:00 UTC on the 1st. USD per GPU-hour; median across regions of the cheapest offer per region.",
  points,
});
log(`✓ gpu-spot-history.json — ${points.length} monthly readings (${points.length - before} new), ${points[0]?.date} to ${points.at(-1)?.date}`);
