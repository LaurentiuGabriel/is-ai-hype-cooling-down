// Pulls live GPU rental prices (spot vs. on-demand) from the Azure Retail Prices
// API, a public endpoint that needs no key. Writes data/gpu-spot.json.
//
// Why spot: on-demand list prices almost never move, but spot is repriced against
// spare capacity. A deep spot discount means idle chips; a spot price pinned at the
// on-demand rate means there is nothing spare to discount.
//
// Offline use: GPU_SPOT_RAW=path/to/response.json replays a saved API response.
import { readFileSync } from "node:fs";
import { fetchJSON, writeData, log } from "./lib.mjs";

const API = "https://prices.azure.com/api/retail/prices";

// One reference VM size per chip generation. Prices are divided by the GPU count
// so every figure is USD per GPU-hour.
const GPUS = [
  { key: "h200", name: "H200", launched: 2024, sku: "Standard_ND96isr_H200_v5", gpus: 8 },
  { key: "h100", name: "H100", launched: 2022, sku: "Standard_NC40ads_H100_v5", gpus: 1 },
  { key: "a100", name: "A100 80GB", launched: 2020, sku: "Standard_NC24ads_A100_v4", gpus: 1 },
  { key: "t4", name: "T4", launched: 2018, sku: "Standard_NC4as_T4_v3", gpus: 1 },
];

// A fixed basket of large commercial regions keeps the reading comparable run to run.
const REGIONS = [
  "eastus", "eastus2", "westus2",
  "westeurope", "northeurope", "swedencentral", "uksouth",
  "japaneast", "southeastasia",
];

const anyOf = (field, values) => `(${values.map((v) => `${field} eq '${v}'`).join(" or ")})`;

function buildUrl() {
  const filter = [
    "type eq 'Consumption'",
    "contains(productName,'Windows') eq false",
    "contains(meterName,'Low Priority') eq false",
    anyOf("armSkuName", GPUS.map((g) => g.sku)),
    anyOf("armRegionName", REGIONS),
  ].join(" and ");
  return `${API}?$filter=${encodeURIComponent(filter)}`;
}

async function fetchItems() {
  if (process.env.GPU_SPOT_RAW) {
    return JSON.parse(readFileSync(process.env.GPU_SPOT_RAW, "utf8")).Items;
  }
  const items = [];
  let url = buildUrl();
  for (let page = 0; url && page < 20; page++) {
    const json = await fetchJSON(url);
    items.push(...(json.Items ?? []));
    url = json.NextPageLink;
  }
  return items;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x, dp = 3) => (x == null ? null : Math.round(x * 10 ** dp) / 10 ** dp);

/** Reduce raw price rows to one {spot, onDemand} pair per region for each chip. */
export function summarize(items) {
  return GPUS.map((g) => {
    const byRegion = new Map();
    for (const it of items) {
      if (it.armSkuName !== g.sku || it.type !== "Consumption") continue;
      if (it.unitOfMeasure !== "1 Hour" || !REGIONS.includes(it.armRegionName)) continue;
      if (/windows/i.test(it.productName) || /low priority/i.test(it.meterName)) continue;
      const row = byRegion.get(it.armRegionName) ?? { region: it.armRegionName };
      const perGpu = it.retailPrice / g.gpus;
      if (/spot/i.test(it.meterName)) {
        row.spot = perGpu;
        row.spotSince = it.effectiveStartDate?.slice(0, 10) ?? null;
      } else {
        row.onDemand = perGpu;
      }
      byRegion.set(it.armRegionName, row);
    }

    // Only regions quoting both prices, so the discount compares like with like.
    const regions = REGIONS.map((r) => byRegion.get(r))
      .filter((r) => r && r.spot != null && r.onDemand)
      .map((r) => ({
        region: r.region,
        spot: round(r.spot),
        onDemand: round(r.onDemand),
        discountPct: round((1 - r.spot / r.onDemand) * 100, 1),
        spotSince: r.spotSince,
      }));

    const cheapest = regions.reduce((a, b) => (a && a.spot <= b.spot ? a : b), null);
    return {
      key: g.key,
      name: g.name,
      launched: g.launched,
      sku: g.sku,
      gpusPerVm: g.gpus,
      spotMedian: round(median(regions.map((r) => r.spot))),
      onDemandMedian: round(median(regions.map((r) => r.onDemand))),
      discountMedianPct: round(median(regions.map((r) => r.discountPct)), 1),
      cheapestSpot: cheapest ? { region: cheapest.region, price: cheapest.spot } : null,
      regions,
    };
  }).filter((g) => g.regions.length);
}

async function main() {
  log("→ Fetching GPU spot + on-demand prices…");
  const items = await fetchItems();
  const gpus = summarize(items);
  if (!gpus.length) throw new Error("No GPU price rows matched; the SKU list may be stale");

  writeData("gpu-spot.json", {
    scrapedAt: new Date().toISOString(),
    source: "Azure Retail Prices API",
    sourceUrl: API,
    unit: "USD per GPU-hour, Linux",
    regionBasket: REGIONS,
    gpus,
  });
  log(
    "✓ gpu-spot.json — " +
      gpus.map((g) => `${g.name} $${g.spotMedian} spot (${g.discountMedianPct}% off)`).join(" · ")
  );
}

main().catch((err) => {
  console.error("✗ GPU spot scrape failed:", err.message);
  process.exit(1);
});
