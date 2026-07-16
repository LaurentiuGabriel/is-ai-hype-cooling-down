// Reads the scraped datasets, computes the headline verdict + supporting
// signals, and injects the result into dist/index.html. No network access.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readData, writeData, pctChange, DIST_DIR, log } from "./lib.mjs";

const QUARTERS_ON_CHART = 13; // ~3 years + a quarter

// ---- scoring helpers --------------------------------------------------------

// Map a year-over-year growth % onto a 0..100 "heat" score.
// 0% growth -> 50 (neutral). +hot% or more -> 100. -hot% or less -> 0.
function scoreFromGrowth(g, hot = 40) {
  if (g == null) return null;
  return Math.max(0, Math.min(100, 50 + (g / hot) * 50));
}

const fmtPct = (g) => (g == null ? "n/a" : `${g >= 0 ? "+" : ""}${g.toFixed(0)}%`);

// ---- combined hyperscaler series -------------------------------------------

// Sum a metric across companies per calendar-quarter end date, keeping only the
// quarters where every company reported (so YoY/QoQ compare like-for-like).
function combineByQuarter(companies, metric) {
  const n = companies.length;
  const counts = new Map(); // end -> {sum, count}
  for (const c of companies) {
    for (const q of c[metric]) {
      const e = counts.get(q.end) ?? { sum: 0, count: 0 };
      e.sum += q.val;
      e.count += 1;
      counts.set(q.end, e);
    }
  }
  return [...counts.entries()]
    .filter(([, v]) => v.count === n)
    .map(([end, v]) => ({ end, val: v.sum }))
    .sort((a, b) => new Date(a.end) - new Date(b.end));
}

function yoy(series, i) {
  return i >= 4 ? pctChange(series[i - 4].val, series[i].val) : null;
}

// ---- interconnection helpers -----------------------------------------------

function lastCompleteYearPair(byYear, currentYear) {
  const complete = byYear.filter((d) => d.year < currentYear);
  const last = complete.at(-1);
  const prior = complete.at(-2);
  return { last, prior };
}

// ---- main -------------------------------------------------------------------

function build() {
  const infra = readData("interconnection.json");
  const hyper = readData("hyperscalers.json");
  const currentYear = new Date(hyper.scrapedAt).getUTCFullYear();

  // Combined hyperscaler capex + revenue.
  const capex = combineByQuarter(hyper.companies, "capex");
  const revenue = combineByQuarter(hyper.companies, "revenue");
  const ci = capex.length - 1;
  const ri = revenue.length - 1;

  const capexLatest = capex[ci];
  const capexYoY = yoy(capex, ci);
  const capexQoQ = ci >= 1 ? pctChange(capex[ci - 1].val, capex[ci].val) : null;
  const capexTTM = capex.slice(-4).reduce((s, q) => s + q.val, 0);
  const capexTTMPrior = capex.slice(-8, -4).reduce((s, q) => s + q.val, 0);
  const capexTTMYoY = capexTTMPrior ? pctChange(capexTTMPrior, capexTTM) : null;

  const revYoY = yoy(revenue, ri);

  // Interconnection (data-center load) year-over-year on last complete years.
  const dc = infra.dataCenters;
  const gen = infra.generation;
  const dcCap = lastCompleteYearPair(dc.byYear, currentYear);
  const dcCnt = dcCap; // same pair, different field
  const genCap = lastCompleteYearPair(gen.byYear, currentYear);

  const dcCapacityYoY = pctChange(dcCap.prior?.capacityMw, dcCap.last?.capacityMw);
  const dcCountYoY = pctChange(dcCnt.prior?.requests, dcCnt.last?.requests);
  const genCapacityYoY = pctChange(genCap.prior?.capacityMw, genCap.last?.capacityMw);

  // ---- signals -------------------------------------------------------------
  const signals = [
    {
      key: "capex",
      label: "Infrastructure investment",
      blurb: "Combined quarterly capital spending by the five largest platform operators, versus a year earlier.",
      value: `$${(capexLatest.val / 1e9).toFixed(0)}B / qtr`,
      change: fmtPct(capexYoY),
      score: scoreFromGrowth(capexYoY),
      weight: 0.3,
    },
    {
      key: "momentum",
      label: "Spending momentum",
      blurb: "Whether that investment is still climbing quarter-on-quarter or has started to roll over.",
      value: `${fmtPct(capexQoQ)} vs prior qtr`,
      change: fmtPct(capexQoQ),
      score: scoreFromGrowth(capexQoQ, 15),
      weight: 0.15,
    },
    {
      key: "revenue",
      label: "Platform demand",
      blurb: "Combined top-line revenue growth, the paying demand that the build-out is meant to serve.",
      value: `$${(revenue[ri].val / 1e9).toFixed(0)}B / qtr`,
      change: fmtPct(revYoY),
      score: scoreFromGrowth(revYoY),
      weight: 0.2,
    },
    {
      key: "power",
      label: "Data-center power pipeline",
      blurb: `New large-load electrical capacity entering the build queue (${dcCap.last?.year} vs ${dcCap.prior?.year}).`,
      value: `${(dcCap.last?.capacityMw / 1000).toFixed(1)} GW added`,
      change: fmtPct(dcCapacityYoY),
      score: scoreFromGrowth(dcCapacityYoY),
      weight: 0.2,
    },
    {
      key: "projects",
      label: "New project starts",
      blurb: `Count of new large-load facilities queued to connect (${dcCnt.last?.year} vs ${dcCnt.prior?.year}).`,
      value: `${dcCnt.last?.requests} projects`,
      change: fmtPct(dcCountYoY),
      score: scoreFromGrowth(dcCountYoY),
      weight: 0.15,
    },
  ];

  const scored = signals.filter((s) => s.score != null);
  const totalWeight = scored.reduce((s, x) => s + x.weight, 0);
  const heat = Math.round(scored.reduce((s, x) => s + x.score * x.weight, 0) / totalWeight);

  // ---- verdict bands -------------------------------------------------------
  const bands = [
    { min: 62, answer: "No.", tag: "It's still accelerating", tone: "hot" },
    { min: 50, answer: "Not really.", tag: "Spending stays elevated and demand keeps broadening", tone: "warm" },
    { min: 38, answer: "Mixed signals.", tag: "Momentum is leveling off", tone: "neutral" },
    { min: 25, answer: "Starting to.", tag: "Cooling at the edges", tone: "cool" },
    { min: -1, answer: "Yes.", tag: "The data points to a cooldown", tone: "cold" },
  ];
  const band = bands.find((b) => heat >= b.min);

  const combined = {
    generatedAt: new Date().toISOString(),
    dataThrough: capexLatest.end,
    infraUpdated: infra.sourceLastUpdated,
    verdict: {
      heat,
      answer: band.answer,
      tag: band.tag,
      tone: band.tone,
    },
    signals: signals.map((s) => ({
      label: s.label,
      blurb: s.blurb,
      value: s.value,
      change: s.change,
      score: s.score == null ? null : Math.round(s.score),
    })),
    headline: {
      combinedQuarterlyCapex: Math.round(capexLatest.val / 1e8) / 10, // $B, 1 decimal
      combinedCapexYoY: capexYoY == null ? null : Math.round(capexYoY),
      combinedTTMCapex: Math.round(capexTTM / 1e9),
      combinedTTMCapexYoY: capexTTMYoY == null ? null : Math.round(capexTTMYoY),
      combinedQuarterlyRevenue: Math.round(revenue[ri].val / 1e9),
      combinedRevenueYoY: revYoY == null ? null : Math.round(revYoY),
      dcActiveCapacityGw: Math.round(dc.totalCapacityMw / 100) / 10,
      dcActiveRequests: dc.totalActiveRequests,
      dcCapacityYoY: dcCapacityYoY == null ? null : Math.round(dcCapacityYoY),
      genActiveCapacityGw: Math.round(gen.totalCapacityMw / 100) / 10,
      genCapacityYoY: genCapacityYoY == null ? null : Math.round(genCapacityYoY),
      totalQueueAllTime: infra.totalRequestsAllTime,
    },
    // Shared quarter axis so every operator's line lines up on the same dates,
    // even when one (e.g. Oracle) has already reported a quarter the others haven't.
    charts: (() => {
      const chartQuarters = capex.slice(-QUARTERS_ON_CHART);
      return {
      capexCombined: chartQuarters.map((q) => ({ end: q.end, val: Math.round(q.val / 1e8) / 10 })),
      companies: hyper.companies.map((c) => {
        const byEnd = new Map(c.capex.map((q) => [q.end, q.val]));
        return {
          name: c.name,
          color: c.color,
          capex: chartQuarters.map((q) => ({
            end: q.end,
            val: byEnd.has(q.end) ? Math.round(byEnd.get(q.end) / 1e8) / 10 : null,
          })),
          latestYoY: c.capex.at(-1)?.yoyPct == null ? null : Math.round(c.capex.at(-1).yoyPct),
        };
      }),
      dcCapacityByYear: dc.byYear.map((d) => ({ year: d.year, gw: Math.round(d.capacityMw / 100) / 10, requests: d.requests })),
      genCapacityByYear: gen.byYear.map((d) => ({ year: d.year, gw: Math.round(d.capacityMw / 100) / 10 })),
      dcTopStates: dc.topStates.map((s) => ({ state: s.state, gw: Math.round(s.capacityMw / 100) / 10 })),
      currentYear,
      };
    })(),
  };

  writeData("combined.json", combined);

  // Inject into the static page.
  const htmlPath = resolve(DIST_DIR, "index.html");
  let html = readFileSync(htmlPath, "utf8");
  const payload = `window.__DATA__ = ${JSON.stringify(combined)};`;
  html = html.replace(
    /\/\*__DATA_START__\*\/[\s\S]*?\/\*__DATA_END__\*\//,
    `/*__DATA_START__*/\n    ${payload}\n    /*__DATA_END__*/`
  );
  writeFileSync(htmlPath, html);

  log(`✓ Verdict: "${band.answer} ${band.tag}"  heat=${heat}/100  (data through ${capexLatest.end})`);
  log(`  capex ${fmtPct(capexYoY)} YoY · revenue ${fmtPct(revYoY)} YoY · DC power ${fmtPct(dcCapacityYoY)} YoY`);
}

build();
