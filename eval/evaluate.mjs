// Pure evaluation logic: loading cases, fitting cut points, and the statistics reported by
// eval/routing-eval.mjs. No network; tested in test/evaluate.test.mjs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const TIERS = ["haiku", "sonnet", "opus"];
const REQUIRED = ["id", "prompt", "label", "source", "license", "split"];

/** Every case in `dir/*.jsonl`, validated. Throws naming the file and line of a bad row. */
export function loadCases(dir) {
  const cases = [];
  const ids = new Set();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    readFileSync(join(dir, file), "utf8").split("\n").forEach((line, i) => {
      if (!line.trim()) return;
      const where = `${file}:${i + 1}`;
      const row = JSON.parse(line);
      const missing = REQUIRED.filter((k) => typeof row[k] !== "string" || !row[k]);
      if (missing.length) throw new Error(`${where}: missing ${missing.join(", ")}`);
      if (!TIERS.includes(row.label)) throw new Error(`${where}: label must be one of ${TIERS.join("|")}`);
      if (!["train", "holdout"].includes(row.split)) throw new Error(`${where}: split must be train|holdout`);
      if (ids.has(row.id)) throw new Error(`${where}: duplicate id ${row.id}`);
      ids.add(row.id);
      cases.push(row);
    });
  }
  return cases;
}

export const classify = (d, cuts) => (d < cuts.sonnet ? "haiku" : d < cuts.opus ? "sonnet" : "opus");

/** Wilson score interval for k successes in n trials (95% by default). */
export function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 1];
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const gap = (got, want) => TIERS.indexOf(got) - TIERS.indexOf(want);

/**
 * Grid search over cut pairs at midpoints between observed difficulties (plus both ends, so a
 * tier may receive nothing). Objective: most exact matches; ties go to fewer under-routes,
 * then to the lower cut pair, so the result is deterministic.
 * @param {{d: number, label: string}[]} rows  train rows only
 */
export function fitCuts(rows) {
  const ds = [...new Set(rows.map((r) => r.d))].sort((a, b) => a - b);
  const candidates = [0, ...ds.slice(1).map((d, i) => (d + ds[i]) / 2), 1 + 1e-9];
  let best = null;
  for (let a = 0; a < candidates.length; a++) {
    for (let b = a; b < candidates.length; b++) {
      const cuts = { sonnet: candidates[a], opus: candidates[b] };
      let exact = 0;
      let under = 0;
      for (const r of rows) {
        const g = gap(classify(r.d, cuts), r.label);
        if (g === 0) exact++;
        else if (g < 0) under++;
      }
      if (!best || exact > best.exact || (exact === best.exact && under < best.under)) best = { cuts, exact, under };
    }
  }
  return best.cuts;
}

/**
 * @param {{id: string, d: number, label: string, source: string, prompt: string}[]} rows
 * @returns metrics for all rows together and per source
 */
export function metrics(rows, cuts) {
  const summarise = (subset) => {
    const confusion = Object.fromEntries(TIERS.map((want) => [want, Object.fromEntries(TIERS.map((got) => [got, 0]))]));
    const underCases = [];
    let exact = 0;
    let over = 0;
    for (const r of subset) {
      const got = classify(r.d, cuts);
      confusion[r.label][got]++;
      const g = gap(got, r.label);
      if (g === 0) exact++;
      else if (g > 0) over++;
      else underCases.push({ id: r.id, label: r.label, got, d: r.d, prompt: r.prompt });
    }
    const n = subset.length;
    return {
      n,
      exact,
      accuracy: n ? exact / n : 0,
      accuracyCI: wilson(exact, n),
      overRate: n ? over / n : 0,
      underRate: n ? underCases.length / n : 0,
      underCases,
      confusion,
    };
  };
  const bySource = {};
  for (const source of [...new Set(rows.map((r) => r.source))].sort()) {
    bySource[source] = summarise(rows.filter((r) => r.source === source));
  }
  return { overall: summarise(rows), bySource };
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
