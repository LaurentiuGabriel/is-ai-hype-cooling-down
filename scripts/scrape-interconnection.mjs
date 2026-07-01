// Scrapes grid-interconnection queue data (a leading indicator of physical
// build-out for large computing loads / data centers). Writes data/interconnection.json.
import { fetchText, fetchJSON, writeData, log, sleep } from "./lib.mjs";

const BASE = "https://www.interconnection.fyi";

/** Pull the current Next.js buildId so the data endpoint keeps working across redeploys. */
async function resolveBuildId() {
  const html = await fetchText(`${BASE}/`);
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("Could not locate __NEXT_DATA__ in homepage");
  const next = JSON.parse(m[1]);
  const lastUpdated = extractLastUpdated(html);
  return { buildId: next.buildId, lastUpdated };
}

function extractLastUpdated(html) {
  // e.g. "Jun 30, 2026, 9:14 AM UTC"
  const m = html.match(/[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M UTC/);
  return m ? m[0] : null;
}

/** Query the data endpoint for a given filter set, following internal redirects. */
async function getView(buildId, query) {
  let qs = new URLSearchParams(query).toString();
  for (let hop = 0; hop < 5; hop++) {
    const url = `${BASE}/_next/data/${buildId}/index.json${qs ? "?" + qs : ""}`;
    const json = await fetchJSON(url);
    if (json?.pageProps?.__N_REDIRECT) {
      qs = json.pageProps.__N_REDIRECT.split("?")[1] ?? "";
      continue;
    }
    if (!json?.pageProps?.data) throw new Error(`No data for query ${qs}`);
    return json.pageProps.data;
  }
  throw new Error(`Too many redirects for ${qs}`);
}

/** Reduce the raw time series to clean yearly points (drops null spacer rows). */
function yearly(series) {
  return series
    .filter((d) => Number.isInteger(d.year) && d.totalInterconnectionRequests != null)
    .map((d) => ({
      year: d.year,
      requests: d.totalInterconnectionRequests,
      capacityMw: Math.round(d.totalCapacityMw),
    }));
}

function topStates(stateData, n = 8) {
  if (!Array.isArray(stateData)) return [];
  return [...stateData]
    .map((s) => ({
      state: s.stateCode ?? s.state ?? s.name ?? s.label,
      requests: s.totalInterconnectionRequests ?? s.requests ?? s.count ?? 0,
      capacityMw: Math.round(s.totalCapacityMw ?? s.capacityMw ?? s.capacity ?? 0),
    }))
    .filter((s) => s.state)
    .sort((a, b) => b.capacityMw - a.capacityMw)
    .slice(0, n);
}

async function main() {
  log("→ Resolving data endpoint…");
  const { buildId, lastUpdated } = await resolveBuildId();
  log(`  buildId=${buildId} lastUpdated=${lastUpdated ?? "n/a"}`);

  // Data-center-relevant electrical loads seeking to connect to the grid.
  log("→ Fetching large-load (data center) queue…");
  const load = await getView(buildId, { type: "Load", status: "All" });
  await sleep(400);

  // Total active generation build-out (the supply side that AI demand pulls on).
  log("→ Fetching active generation queue…");
  const gen = await getView(buildId, { type: "Generation", status: "Active" });

  const out = {
    scrapedAt: new Date().toISOString(),
    sourceLastUpdated: lastUpdated,
    totalRequestsAllTime: load.totalNumberOfInterconnectionRequestsUnfiltered ?? null,
    minYear: load.minYear,
    maxYear: load.maxYear,
    dataCenters: {
      totalActiveRequests: load.statCardsData?.numInterconnectionRequests ?? null,
      totalCapacityMw: Math.round(load.statCardsData?.totalCapacityMW ?? 0),
      byYear: yearly(load.requestCountAndCapacityByTimeChartData ?? []),
      topStates: topStates(load.requestCountAndCapacityByStateChartData),
    },
    generation: {
      totalActiveRequests: gen.statCardsData?.numInterconnectionRequests ?? null,
      totalCapacityMw: Math.round(gen.statCardsData?.totalCapacityMW ?? 0),
      byYear: yearly(gen.requestCountAndCapacityByTimeChartData ?? []),
    },
  };

  writeData("interconnection.json", out);
  log(
    `✓ interconnection.json — data-center: ${out.dataCenters.totalActiveRequests} reqs / ${out.dataCenters.totalCapacityMw} MW active; ` +
      `${out.dataCenters.byYear.length} years of history`
  );
}

main().catch((err) => {
  console.error("✗ interconnection scrape failed:", err.message);
  process.exit(1);
});
