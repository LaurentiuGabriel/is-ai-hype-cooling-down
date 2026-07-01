// Scrapes quarterly capital expenditure + revenue for the four largest
// cloud/AI platform operators from their public financial disclosures (XBRL).
// Writes data/hyperscalers.json.
import { fetchJSON, writeData, quarterizeCumulative, pctChange, log, sleep } from "./lib.mjs";

// Contact string per the data host's fair-access guidance.
const UA = "ai-hype-index/1.0 (research contact: ai-hype-index@example.com)";

const COMPANIES = [
  { key: "microsoft", name: "Microsoft", cik: "0000789019", color: "#22d3ee" },
  { key: "alphabet", name: "Alphabet", cik: "0001652044", color: "#a78bfa" },
  { key: "amazon", name: "Amazon", cik: "0001018724", color: "#f59e0b" },
  { key: "meta", name: "Meta", cik: "0001326801", color: "#34d399" },
];

// Capex ("purchases of property & equipment") is tagged differently across
// companies; revenue likewise migrated tags over the years. Try each in order
// and merge everything we can find.
const CAPEX_TAGS = [
  "PaymentsToAcquirePropertyPlantAndEquipment",
  "PaymentsToAcquireProductiveAssets",
];
const REVENUE_TAGS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "Revenues",
];

async function concept(cik, tag) {
  const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`;
  try {
    return await fetchJSON(url, { headers: { "User-Agent": UA } });
  } catch {
    return null; // tag not used by this company
  }
}

/** Merge USD datapoints across a list of candidate tags, then quarterize. */
async function seriesFrom(cik, tags) {
  const merged = [];
  for (const tag of tags) {
    const j = await concept(cik, tag);
    await sleep(200);
    const usd = j?.units?.USD;
    if (Array.isArray(usd)) {
      for (const u of usd) {
        if (u.form === "10-Q" || u.form === "10-K") merged.push(u);
      }
    }
  }
  return quarterizeCumulative(merged);
}

function attachYoY(series) {
  // Each quarter compared to the same quarter one year earlier (index - 4).
  return series.map((q, i) => ({
    end: q.end,
    val: q.val,
    yoyPct: i >= 4 ? pctChange(series[i - 4].val, q.val) : null,
  }));
}

async function main() {
  const companies = [];
  for (const c of COMPANIES) {
    log(`→ ${c.name}…`);
    const capex = attachYoY(await seriesFrom(c.cik, CAPEX_TAGS));
    const revenue = attachYoY(await seriesFrom(c.cik, REVENUE_TAGS));
    const latest = capex.at(-1);
    log(
      `  capex: ${capex.length} qtrs, latest ${latest?.end} = $${(latest?.val / 1e9).toFixed(1)}B ` +
        `(${latest?.yoyPct != null ? (latest.yoyPct >= 0 ? "+" : "") + latest.yoyPct.toFixed(0) + "% YoY" : "n/a"})`
    );
    companies.push({
      key: c.key,
      name: c.name,
      color: c.color,
      // Trim to the last ~5 years to keep the payload lean.
      capex: capex.slice(-20),
      revenue: revenue.slice(-20),
    });
  }

  writeData("hyperscalers.json", {
    scrapedAt: new Date().toISOString(),
    companies,
  });
  log(`✓ hyperscalers.json — ${companies.length} operators`);
}

main().catch((err) => {
  console.error("✗ hyperscaler scrape failed:", err.message);
  process.exit(1);
});
