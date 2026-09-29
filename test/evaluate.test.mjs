import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classify, fitCuts, loadCases, median, metrics, wilson } from "../eval/evaluate.mjs";

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("wilson matches the textbook 95% interval", () => {
  const [lo, hi] = wilson(8, 10);
  close(lo, 0.4902);
  close(hi, 0.9433);
  assert.deepEqual(wilson(0, 0), [0, 1]);
  const [lo0] = wilson(0, 20);
  assert.equal(lo0, 0);
});

test("fitCuts separates cleanly separable data", () => {
  const rows = [
    ...[0.1, 0.2, 0.25].map((d) => ({ d, label: "haiku" })),
    ...[0.4, 0.45].map((d) => ({ d, label: "sonnet" })),
    ...[0.7, 0.9].map((d) => ({ d, label: "opus" })),
  ];
  const cuts = fitCuts(rows);
  assert.ok(rows.every((r) => classify(r.d, cuts) === r.label), JSON.stringify(cuts));
  close(cuts.sonnet, 0.325);
  close(cuts.opus, 0.575);
});

test("fitCuts breaks accuracy ties toward fewer under-routes", () => {
  // A haiku and a sonnet case at the same difficulty: any cut gets exactly one of them right.
  // Routing both to sonnet (an over-route) must win over routing both to haiku (an under-route).
  const rows = [
    { d: 0.1, label: "haiku" },
    { d: 0.5, label: "haiku" },
    { d: 0.5, label: "sonnet" },
    { d: 0.9, label: "opus" },
  ];
  const cuts = fitCuts(rows);
  assert.equal(classify(0.1, cuts), "haiku");
  assert.equal(classify(0.5, cuts), "sonnet");
  assert.equal(classify(0.9, cuts), "opus");
});

test("metrics reports accuracy, over/under rates, confusion and under-routed cases per source", () => {
  const cuts = { sonnet: 0.33, opus: 0.66 };
  const rows = [
    { id: "a", d: 0.1, label: "haiku", source: "x", prompt: "p1" },
    { id: "b", d: 0.5, label: "haiku", source: "x", prompt: "p2" }, // over
    { id: "c", d: 0.5, label: "opus", source: "y", prompt: "p3" }, // under
    { id: "d", d: 0.9, label: "opus", source: "y", prompt: "p4" },
  ];
  const m = metrics(rows, cuts);
  assert.equal(m.overall.n, 4);
  assert.equal(m.overall.accuracy, 0.5);
  assert.equal(m.overall.overRate, 0.25);
  assert.equal(m.overall.underRate, 0.25);
  assert.deepEqual(m.overall.underCases.map((u) => u.id), ["c"]);
  assert.equal(m.overall.confusion.opus.sonnet, 1);
  assert.equal(m.overall.confusion.haiku.sonnet, 1);
  assert.deepEqual(Object.keys(m.bySource), ["x", "y"]);
  assert.equal(m.bySource.x.accuracy, 0.5);
  assert.equal(m.bySource.y.underRate, 0.5);
});

test("loadCases validates rows and rejects duplicates", () => {
  const dir = mkdtempSync(join(tmpdir(), "laya-cases-"));
  const row = { id: "1", prompt: "p", label: "haiku", source: "s", license: "MIT", split: "train" };
  writeFileSync(join(dir, "a.jsonl"), `${JSON.stringify(row)}\n\n`);
  assert.equal(loadCases(dir).length, 1);

  writeFileSync(join(dir, "b.jsonl"), `${JSON.stringify({ ...row, id: "2", label: "fable" })}\n`);
  assert.throws(() => loadCases(dir), /b\.jsonl:1: label/);
  writeFileSync(join(dir, "b.jsonl"), `${JSON.stringify(row)}\n`);
  assert.throws(() => loadCases(dir), /duplicate id 1/);
  writeFileSync(join(dir, "b.jsonl"), `${JSON.stringify({ ...row, id: "3", license: "" })}\n`);
  assert.throws(() => loadCases(dir), /missing license/);
});

test("the shipped eval data loads", () => {
  const cases = loadCases(fileURLToPath(new URL("../eval/data", import.meta.url)));
  assert.ok(cases.length >= 42);
});

test("median handles odd, even and empty inputs", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});
