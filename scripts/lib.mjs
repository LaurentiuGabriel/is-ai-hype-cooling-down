// Shared helpers for the scrape + build pipeline.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = resolve(ROOT, "data");
export const DIST_DIR = resolve(ROOT, "dist");

const DEFAULT_UA =
  "Mozilla/5.0 (compatible; ai-hype-index/1.0; research)";

/** Fetch with a couple of retries and a browser-ish UA. */
export async function fetchWithRetry(url, { headers = {}, tries = 4, delayMs = 600 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": DEFAULT_UA, "Accept-Encoding": "gzip, deflate", ...headers },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await sleep(delayMs * attempt);
    }
  }
  throw lastErr;
}

export async function fetchJSON(url, opts) {
  const res = await fetchWithRetry(url, opts);
  return res.json();
}

export async function fetchText(url, opts) {
  const res = await fetchWithRetry(url, opts);
  return res.text();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const daysBetween = (a, b) =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);

/**
 * Turn a cumulative-per-fiscal-year value series (as reported in filings) into
 * clean standalone-quarter values. Filings report figures cumulatively from the
 * start of each fiscal year (3-month, 6-month, 9-month, full-year), so quarters
 * are recovered by differencing consecutive cumulatives that share a start date.
 * Works regardless of fiscal-year-end, and recovers Q4 (only in annual reports).
 *
 * @param {Array<{start:string,end:string,val:number,filed:string}>} points
 * @returns {Array<{end:string,val:number,days:number}>} sorted ascending by end
 */
export function quarterizeCumulative(points) {
  // Keep the most recently filed value for each exact (start,end) period.
  const byPeriod = new Map();
  for (const p of points) {
    if (!p.start || !p.end || p.val == null) continue;
    const key = `${p.start}|${p.end}`;
    const prev = byPeriod.get(key);
    if (!prev || new Date(p.filed) > new Date(prev.filed)) byPeriod.set(key, p);
  }

  // Group by start date; within each group, cumulative periods differ only by end.
  const byStart = new Map();
  for (const p of byPeriod.values()) {
    if (!byStart.has(p.start)) byStart.set(p.start, []);
    byStart.get(p.start).push(p);
  }

  const out = new Map(); // keyed by end date to dedupe
  for (const [start, group] of byStart) {
    group.sort((a, b) => new Date(a.end) - new Date(b.end));
    let prevVal = 0;
    let prevEnd = start;
    for (const cur of group) {
      const val = cur.val - prevVal;
      const days = daysBetween(prevEnd, cur.end);
      if (days >= 80 && days <= 100) out.set(cur.end, { end: cur.end, val, days });
      prevVal = cur.val;
      prevEnd = cur.end;
    }
  }
  return [...out.values()].sort((a, b) => new Date(a.end) - new Date(b.end));
}

/** Percentage change from a -> b, guarding divide-by-zero. */
export function pctChange(from, to) {
  if (!from) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

export function readData(name) {
  return JSON.parse(readFileSync(resolve(DATA_DIR, name), "utf8"));
}

export function writeData(name, obj) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(resolve(DATA_DIR, name), JSON.stringify(obj, null, 2));
}

export function log(...args) {
  console.log(...args);
}
