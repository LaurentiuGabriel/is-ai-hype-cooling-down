// Shared logic for reading GPU prices out of the SkyPilot catalog, a public
// GitHub repo of per-cloud price CSVs that bots refresh several times a day.
// Its git history doubles as a price archive going back to mid-2022.
//
// Every figure this module returns is USD per GPU-hour.

export const CATALOG_REPO = "skypilot-org/skypilot-catalog";
export const CATALOG_BRANCH = "master";

// Chips tracked, newest first. `accel` is the catalog's AcceleratorName.
export const CHIPS = [
  { key: "b200", name: "B200", launched: 2025, accel: "B200" },
  { key: "h200", name: "H200", launched: 2024, accel: "H200" },
  { key: "h100", name: "H100", launched: 2022, accel: "H100" },
  { key: "a100", name: "A100 80GB", launched: 2020, accel: "A100-80GB" },
  { key: "t4", name: "T4", launched: 2018, accel: "T4" },
];

// Clouds read from the catalog. All three publish a spot price next to the
// on-demand one. (Azure is read from its own API in scrape-gpu-spot.mjs.)
export const CATALOG_PROVIDERS = [
  { key: "aws", name: "AWS", color: "#fbbf24" },
  { key: "gcp", name: "Google Cloud", color: "#34d399" },
  { key: "nebius", name: "Nebius", color: "#fb7185" },
];

// Google prices the accelerator and its host VM separately, so a GPU-hour is
// the accelerator plus its share of the machine it has to be attached to.
// `{n}` is the GPU count.
const GCP_HOSTS = {
  B200: "a4-highgpu-{n}g",
  H200: "a3-ultragpu-{n}g",
  H100: "a3-highgpu-{n}g",
  "A100-80GB": "a2-ultragpu-{n}g",
  T4: "n1-standard-4",
};

/** Minimal CSV reader: handles quoted fields with embedded commas. */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const split = (line) => {
    const out = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = split(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = split(l);
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

const num = (s) => {
  const v = Number.parseFloat(s);
  return Number.isFinite(v) && v > 0 ? v : null;
};
const zeroOk = (s) => {
  const v = Number.parseFloat(s);
  return Number.isFinite(v) && v >= 0 ? v : null;
};
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x, dp = 3) => (x == null ? null : Math.round(x * 10 ** dp) / 10 ** dp);

/**
 * Collapse per-offer quotes into one reading per chip: the cheapest way to
 * rent that chip in each region, then the median across regions. Only regions
 * quoting both a spot and an on-demand price count, so the two medians and the
 * discount describe the same set of places.
 */
function reduceQuotes(quotes) {
  const out = {};
  for (const chip of CHIPS) {
    const byRegion = new Map();
    for (const q of quotes) {
      if (q.accel !== chip.accel) continue;
      const r = byRegion.get(q.region) ?? { spot: null, onDemand: null };
      if (q.spot != null && (r.spot == null || q.spot < r.spot)) r.spot = q.spot;
      if (q.onDemand != null && (r.onDemand == null || q.onDemand < r.onDemand)) r.onDemand = q.onDemand;
      byRegion.set(q.region, r);
    }
    const both = [...byRegion.values()].filter((r) => r.spot != null && r.onDemand != null);
    if (!both.length) continue;
    const spot = median(both.map((r) => r.spot));
    const onDemand = median(both.map((r) => r.onDemand));
    out[chip.key] = {
      spot: round(spot),
      onDemand: round(onDemand),
      discountPct: round((1 - spot / onDemand) * 100, 1),
      regions: both.length,
    };
  }
  return out;
}

/** AWS and Nebius: one row per instance offer, GPU included in the price. */
function quotesFromBundled(rows) {
  const quotes = [];
  for (const r of rows) {
    const n = num(r.AcceleratorCount);
    if (!r.AcceleratorName || !n || !r.InstanceType) continue;
    const onDemand = num(r.Price);
    const spot = num(r.SpotPrice);
    quotes.push({
      accel: r.AcceleratorName,
      region: r.Region,
      onDemand: onDemand && onDemand / n,
      spot: spot && spot / n,
    });
  }
  return quotes;
}

/** Google Cloud: accelerator rows plus the matching host VM in the same zone. */
function quotesFromGcp(rows) {
  const hosts = new Map(); // "type|zone" -> {price, spot}
  for (const r of rows) {
    if (r.InstanceType && !r.AcceleratorName) {
      // A host listed at 0 is real: for some machine types the whole price sits on the GPU row.
      hosts.set(`${r.InstanceType}|${r.AvailabilityZone}`, { onDemand: zeroOk(r.Price), spot: zeroOk(r.SpotPrice) });
    }
  }
  const quotes = [];
  for (const r of rows) {
    const tmpl = GCP_HOSTS[r.AcceleratorName];
    const n = num(r.AcceleratorCount);
    if (r.InstanceType || !tmpl || !n) continue;
    if (!tmpl.includes("{n}") && n !== 1) continue;
    const host = hosts.get(`${tmpl.replace("{n}", n)}|${r.AvailabilityZone}`);
    if (!host) continue;
    const onDemand = num(r.Price);
    const spot = num(r.SpotPrice);
    quotes.push({
      accel: r.AcceleratorName,
      region: r.Region,
      onDemand: onDemand && host.onDemand != null ? (onDemand + host.onDemand) / n : null,
      spot: spot && host.spot != null ? (spot + host.spot) / n : null,
    });
  }
  return quotes;
}

/** CSV text of one provider's vms.csv -> { chipKey: {spot,onDemand,discountPct,regions} } */
export function summarizeCatalog(providerKey, csvText) {
  const rows = parseCsv(csvText);
  return reduceQuotes(providerKey === "gcp" ? quotesFromGcp(rows) : quotesFromBundled(rows));
}

export const catalogPath = (version, providerKey) => `catalogs/${version}/${providerKey}/vms.csv`;

/** First-of-month dates (YYYY-MM-01) from `from` through `to`, inclusive. */
export function monthStarts(from, to) {
  const out = [];
  const d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}
