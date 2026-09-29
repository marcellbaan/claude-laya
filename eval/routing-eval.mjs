// Scores the labelled prompts against a running Laya server with the exact questions and
// cut points laya-claude uses. Run: npm run eval (needs laya-serve on LAYA_URL).
import { buildRequest, difficulty, tierFor } from "../src/score.mjs";
import { HOLDOUT, TRAIN } from "./cases.mjs";

const TIERS = ["haiku", "sonnet", "opus"];
const latencies = [];

async function score([want, prompt]) {
  const started = Date.now();
  const { url, init } = buildRequest(prompt);
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`Laya HTTP ${res.status}: ${await res.text()}`);
  latencies.push(Date.now() - started);
  const d = difficulty((await res.json()).answers);
  return { want, got: tierFor(d), d, prompt };
}

for (const [name, set] of [["train", TRAIN], ["holdout", HOLDOUT]]) {
  const rows = [];
  for (const c of set) rows.push(await score(c));
  const gap = (r) => TIERS.indexOf(r.got) - TIERS.indexOf(r.want);
  console.log(
    `${name}: ${rows.filter((r) => !gap(r)).length}/${rows.length} exact, ` +
      `${rows.filter((r) => gap(r) > 0).length} over-routed, ${rows.filter((r) => gap(r) < 0).length} under-routed`,
  );
  for (const r of rows.filter(gap)) console.log(`  ${r.want} -> ${r.got} (d=${r.d.toFixed(3)}) ${r.prompt}`);
}
latencies.sort((a, b) => a - b);
console.log(`latency ms: median ${latencies[latencies.length >> 1]}, max ${latencies.at(-1)}`);
