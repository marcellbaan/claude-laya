// Scores every case in eval/data/*.jsonl with a running Laya server, fits cut points on the
// train split, and reports the holdout split only.
//
//   npm run eval -- [--cuts fitted|configured] [--min-accuracy 0.6] [--max-under-route 0.15] [--json out.json]
//
// Gates exit non-zero when breached. They check the fitted cuts by default; pass
// `--cuts configured` to gate what src/score.mjs currently ships.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CUTS, buildRequest, difficulty } from "../src/score.mjs";
import { TIERS, fitCuts, loadCases, median, metrics } from "./evaluate.mjs";

const { values } = parseArgs({
  options: {
    cuts: { type: "string", default: "fitted" },
    "min-accuracy": { type: "string" },
    "max-under-route": { type: "string" },
    json: { type: "string" },
  },
});
if (!["fitted", "configured"].includes(values.cuts)) throw new Error("--cuts must be fitted or configured");

const cases = loadCases(fileURLToPath(new URL("./data", import.meta.url)));
const latencies = [];
const rows = [];
for (const c of cases) {
  const { url, init } = buildRequest(c.prompt);
  const started = Date.now();
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`Laya HTTP ${res.status} on ${c.id}: ${await res.text()}`);
  const d = difficulty((await res.json()).answers);
  latencies.push(Date.now() - started);
  rows.push({ ...c, d });
}

const train = rows.filter((r) => r.split === "train");
const holdout = rows.filter((r) => r.split === "holdout");
const fitted = fitCuts(train);
const results = { fitted: metrics(holdout, fitted), configured: metrics(holdout, CUTS) };
const gated = results[values.cuts];

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const show = (name, m) => {
  const [lo, hi] = m.accuracyCI;
  console.log(
    `  ${name.padEnd(14)} n=${String(m.n).padStart(4)}  exact ${pct(m.accuracy)} [${pct(lo)}, ${pct(hi)}]  ` +
      `over ${pct(m.overRate)}  under ${pct(m.underRate)}`,
  );
};
const fmt = (c) => `sonnet >= ${c.sonnet.toFixed(3)}, opus >= ${c.opus.toFixed(3)}`;
console.log(`${cases.length} cases: ${train.length} train, ${holdout.length} holdout`);
console.log(`fitted cuts (train):  ${fmt(fitted)}`);
console.log(`configured cuts:      ${fmt(CUTS)}\n`);
for (const [name, m] of Object.entries(results)) {
  console.log(`holdout, ${name} cuts (exact accuracy with Wilson 95% interval):`);
  show("overall", m.overall);
  for (const [source, s] of Object.entries(m.bySource)) show(source, s);
  console.log();
}

const { confusion, underCases } = gated.overall;
console.log(`confusion (${values.cuts} cuts; rows = label, columns = routed):`);
console.log(`  ${"".padEnd(7)}${TIERS.map((t) => t.padStart(8)).join("")}`);
for (const want of TIERS) console.log(`  ${want.padEnd(7)}${TIERS.map((got) => String(confusion[want][got]).padStart(8)).join("")}`);
console.log(`\nunder-routed (${values.cuts} cuts), the costly error:`);
for (const u of underCases) console.log(`  ${u.id}: ${u.label} -> ${u.got} (d=${u.d.toFixed(3)}) ${u.prompt.slice(0, 70).replace(/\s+/g, " ")}`);
if (!underCases.length) console.log("  none");
console.log(`\nlatency ms: median ${median(latencies)}, max ${Math.max(...latencies)}`);

if (values.json) {
  const report = { cases: cases.length, cuts: { fitted, configured: CUTS }, results, latency: { median: median(latencies), max: Math.max(...latencies) } };
  writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
}

const failures = [];
if (values["min-accuracy"] && gated.overall.accuracy < Number(values["min-accuracy"])) {
  failures.push(`accuracy ${pct(gated.overall.accuracy)} < ${pct(Number(values["min-accuracy"]))}`);
}
if (values["max-under-route"] && gated.overall.underRate > Number(values["max-under-route"])) {
  failures.push(`under-route rate ${pct(gated.overall.underRate)} > ${pct(Number(values["max-under-route"]))}`);
}
if (failures.length) {
  console.error(`\nFAILED (${values.cuts} cuts): ${failures.join("; ")}`);
  process.exit(1);
}
