// Compares what routed turns actually cost with an always-Opus counterfactual.
//
//   LAYA_DEBUG=1 laya-claude ...                       # records ~/.laya-claude/usage.jsonl
//   cp eval/prices.example.json prices.json            # fill in current prices yourself
//   node eval/usage-report.mjs [--usage FILE] [--prices FILE] [--opus-model ID]
//
// Prices are never shipped: fill them in from Anthropic's pricing page for your plan.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MODELS } from "../src/proxy.mjs";

export const PRICE_FIELDS = ["input", "output", "cache_write_5m", "cache_write_1h", "cache_read"];

/** Every missing or non-numeric price the report needs, as "model.field". */
export function missingPrices(prices, models) {
  const missing = [];
  for (const model of models) {
    for (const field of PRICE_FIELDS) {
      const v = prices?.[model]?.[field];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) missing.push(`${model}.${field}`);
    }
  }
  return missing;
}

/** Token counts split the way they are priced. */
function tokens(usage) {
  const created = usage.cache_creation_input_tokens ?? 0;
  const split = usage.cache_creation;
  const w1h = split?.ephemeral_1h_input_tokens ?? 0;
  const w5m = split ? (split.ephemeral_5m_input_tokens ?? 0) : created;
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cache_write_5m: w5m,
    cache_write_1h: w1h,
    cache_read: usage.cache_read_input_tokens ?? 0,
    unsplitWrites: split ? 0 : created,
  };
}

const cost = (t, p) => PRICE_FIELDS.reduce((sum, f) => sum + (t[f] * p[f]) / 1e6, 0);

export function report(records, prices, opusModel = MODELS.opus) {
  const byTier = {};
  let actual = 0;
  let counterfactual = 0;
  let unsplitWrites = 0;
  const turns = new Set();
  for (const r of records) {
    const t = tokens(r.usage ?? {});
    const a = cost(t, prices[r.model]);
    const c = cost(t, prices[opusModel]);
    actual += a;
    counterfactual += c;
    unsplitWrites += t.unsplitWrites;
    turns.add(`${r.conversation}:${r.turn}`);
    const row = (byTier[r.tier] ??= { requests: 0, turns: new Set(), cost: 0 });
    row.requests++;
    row.turns.add(`${r.conversation}:${r.turn}`);
    row.cost += a;
  }
  return {
    requests: records.length,
    turns: turns.size,
    actual,
    counterfactual,
    savings: counterfactual ? 1 - actual / counterfactual : 0,
    unsplitWrites,
    byTier: Object.fromEntries(Object.entries(byTier).map(([k, v]) => [k, { ...v, turns: v.turns.size }])),
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      usage: { type: "string", default: join(homedir(), ".laya-claude", "usage.jsonl") },
      prices: { type: "string", default: "prices.json" },
      "opus-model": { type: "string", default: MODELS.opus },
    },
  });
  let prices;
  try {
    prices = JSON.parse(readFileSync(values.prices, "utf8"));
  } catch (err) {
    console.error(`Cannot read prices from ${values.prices} (${err.code ?? err.message}).`);
    console.error("Copy eval/prices.example.json to prices.json and fill in current prices.");
    process.exit(1);
  }
  const records = readFileSync(values.usage, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const models = [...new Set([...records.map((r) => r.model), values["opus-model"]])];
  const missing = missingPrices(prices, models);
  if (missing.length) {
    console.error(`Missing prices in ${values.prices} (USD per million tokens):\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }

  const r = report(records, prices, values["opus-model"]);
  const usd = (n) => `$${n.toFixed(4)}`;
  console.log(`${r.turns} turns, ${r.requests} requests\n`);
  for (const [tier, row] of Object.entries(r.byTier)) {
    console.log(`  ${tier.padEnd(7)} ${String(row.turns).padStart(5)} turns ${String(row.requests).padStart(6)} requests  ${usd(row.cost)}`);
  }
  console.log(`\nactual:      ${usd(r.actual)}`);
  console.log(`always-opus: ${usd(r.counterfactual)} (${values["opus-model"]})`);
  console.log(`savings:     ${(r.savings * 100).toFixed(1)}%\n`);
  console.log("Caveats:");
  console.log("- The counterfactual ignores quality: an Opus run of the same turn might have taken");
  console.log("  fewer (or more) requests and tokens, and a cheaper model's mistakes are not priced.");
  console.log("- Always-Opus cache behaviour is estimated from the observed token counts. Real");
  console.log("  always-Opus runs would skip the cache rebuilds that model switches cause.");
  if (r.unsplitWrites) {
    console.log(`- ${r.unsplitWrites} cache-write tokens had no 5m/1h split and were priced as 5-minute writes.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
