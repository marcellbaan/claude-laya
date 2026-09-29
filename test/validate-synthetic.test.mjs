import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MODELS } from "../src/proxy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// A fake `claude` that "solves" the task only on the models named in $FAKE_SOLVES,
// by writing solved.txt into the fixture copy. No real Claude is ever invoked.
function setup(solves) {
  const dir = mkdtempSync(join(tmpdir(), "laya-synth-test-"));
  mkdirSync(join(dir, "fixture"));
  writeFileSync(join(dir, "fixture", "README"), "fixture\n");
  const fake = join(dir, "claude");
  writeFileSync(fake, `#!/bin/sh
model=""
while [ $# -gt 0 ]; do [ "$1" = "--model" ] && model="$2"; shift; done
echo "$model" >> "${dir}/calls.log"
case " $FAKE_SOLVES " in *" $model "*) echo ok > solved.txt ;; esac
`);
  chmodSync(fake, 0o755);
  const input = join(dir, "prompts.jsonl");
  writeFileSync(input, `${JSON.stringify({ id: "s1", prompt: "make solved.txt", fixture: "fixture", grade: "test -f solved.txt", split: "train" })}\n`);
  const run = (...args) =>
    spawnSync(process.execPath, ["eval/validate_synthetic.mjs", "--input", input, "--claude", fake, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, FAKE_SOLVES: solves.map((t) => MODELS[t]).join(" ") },
    });
  const calls = () => {
    try {
      return readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };
  return { dir, run, calls };
}

test("the default is a dry run that invokes nothing", () => {
  const { run, calls } = setup(["haiku"]);
  const r = run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /DRY RUN: 1 prompts, between 1 and 3/);
  assert.match(r.stdout, /Nothing was run/);
  assert.deepEqual(calls(), []);
});

test("--execute labels the cheapest passing tier and stops there", () => {
  const { dir, run, calls } = setup(["sonnet", "opus"]);
  const out = join(dir, "out.jsonl");
  const r = run("--execute", "--out", out);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(), [MODELS.haiku, MODELS.sonnet]);
  const [row] = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(row.label, "sonnet");
  assert.equal(row.source, "synthetic");
  assert.deepEqual(row.runs.map((x) => [x.tier, x.passed]), [["haiku", false], ["sonnet", true]]);
});

test("each tier gets a fresh fixture copy, and unresolved prompts are left out", () => {
  const { dir, run, calls } = setup([]);
  const out = join(dir, "out.jsonl");
  const r = run("--execute", "--out", out);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls().length, 3);
  assert.equal(readFileSync(out, "utf8"), "");
  assert.match(r.stdout, /s1: unresolved/);
});
