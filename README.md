# Is the AI hype cooling down?

A self-updating static page that answers one question — **is the AI hype cooling
down?** — from hard numbers rather than headlines. The answer sits at the top of
the page; the signals that produced it are laid out below.

The current reading: **No — it's still accelerating** (heat index 92/100).

## How it works

A handful of plain Node scripts, no framework, no build toolchain:

```
scripts/
  scrape-interconnection.mjs   → data/interconnection.json   (physical build-out)
  scrape-hyperscalers.mjs      → data/hyperscalers.json      (platform economics)
  scrape-gpu-spot.mjs          → data/gpu-spot.json          (GPU rental prices, today)
  backfill-gpu-history.mjs     → data/gpu-spot-history.json  (GPU spot prices, monthly archive)
  build.mjs                    → data/combined.json + dist/index.html
```

1. **Scrapers** pull the raw numbers and write JSON into `data/`.
2. **`build.mjs`** reads that JSON, computes the composite verdict, and injects the
   result into `dist/index.html` (between the `__DATA_START__ / __DATA_END__`
   markers). All rendering happens client-side from that embedded blob, so the page
   is a single self-contained file that also works straight off disk.

The page is styled with Tailwind and draws its charts with Chart.js (both via CDN).

## Usage

```bash
npm run scrape   # refresh every dataset
npm run build    # recompute the verdict and rewrite the page
npm run update   # scrape + build in one go
```

Then open `dist/index.html` in a browser.

## The verdict, precisely

`build.mjs` scores five independent signals from 0 (contracting) to 100 (surging)
by mapping each one's year-over-year change onto that scale, then takes a weighted
average — the **heat index** — and maps it to a plain-language answer:

| Signal | What it measures | Weight |
| --- | --- | --- |
| Infrastructure investment | Combined quarterly capital spend, YoY | 0.30 |
| Spending momentum | Capital spend, quarter-on-quarter | 0.15 |
| Platform demand | Combined revenue, YoY | 0.20 |
| Data-center power pipeline | New large-load power queued, YoY | 0.20 |
| New project starts | New large-load facilities queued, YoY | 0.15 |

| Heat index | Answer |
| --- | --- |
| ≥ 62 | No — it's still accelerating |
| 50–62 | Not really — spend stays elevated, demand keeps broadening |
| 38–50 | Mixed signals — momentum is leveling off |
| 25–38 | Starting to — cooling at the edges |
| < 25 | Yes — the data points to a cooldown |

Everything is data-driven: rerun the pipeline and the answer, the gauge, the cards,
and the charts all move on their own.

## GPU spot prices

The page tracks spot and on-demand rates for five Nvidia generations (B200, H200,
H100, A100, T4) on four clouds, in USD per GPU-hour. Both sources are public and
need no key:

- **Azure**: the [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices),
  across a fixed basket of nine regions.
- **AWS, Google Cloud, Nebius**: the [SkyPilot catalog](https://github.com/skypilot-org/skypilot-catalog),
  CSV price lists that bots refresh from each cloud's pricing API several times a day.

`scrape-gpu-spot.mjs` reads today's prices into `data/gpu-spot.json`.
`backfill-gpu-history.mjs` walks the catalog's git history and stores one spot
reading per month in `data/gpu-spot-history.json` (back to late 2022 for the older
chips). It needs a local clone of the catalog:

```bash
git clone --filter=blob:none --no-checkout https://github.com/skypilot-org/skypilot-catalog /tmp/skypilot-catalog
npm run backfill:gpu -- /tmp/skypilot-catalog          # add missing months
npm run backfill:gpu -- /tmp/skypilot-catalog --full   # rebuild everything
```

Each figure is the median across regions of the cheapest way to rent the chip in
that region. The history holds spot only: the catalog's on-demand column for Google
Cloud is wrong for long stretches, so it is not charted. Azure has no history
because its API only returns current prices.

The section is context only and does not feed the heat index. The deploy workflow
refetches prices and tops up the history on every deploy and once a day; if either
step fails, the committed files are used instead.

## Notes on the data plumbing

- Quarterly figures are reconstructed from cumulative year-to-date values by
  differencing consecutive periods, which recovers clean standalone quarters
  regardless of each operator's fiscal-year-end (including the fourth quarter,
  which only appears in annual reports).
- The build-out endpoint's build id is resolved dynamically, so the scraper keeps
  working across upstream redeploys.
- The current calendar year is treated as in-progress; year-over-year comparisons
  use the last two completed years, and partial-year bars are dimmed on the charts.
```
