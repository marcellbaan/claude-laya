// Labels synthetic prompts with the cheapest tier that actually completes them: each prompt is
// run with `claude -p` pinned to haiku, then sonnet, then opus, each in a fresh copy of a
// fixture repo, and graded by a shell command that must exit 0. It stops at the first pass.
//
//   node eval/validate_synthetic.mjs --input prompts.jsonl            # dry run: prints the plan
//   node eval/validate_synthetic.mjs --input prompts.jsonl --execute --out eval/data/synthetic.jsonl
//
// Input rows: {"id", "prompt", "fixture": "dir, relative to the input file", "grade": "shell
// command run in the copy", "split": "train|holdout"}.
//
// --execute makes real, billed Claude runs (up to 3 per prompt). By default the agent only gets
// file tools (no Bash), because it runs on this machine; widen that with --claude-args.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MODELS, ORDER } from "../src/proxy.mjs";

const DEFAULT_CLAUDE_ARGS = ["--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,Glob,Grep"];

export function loadPrompts(file) {
  const base = dirname(resolve(file));
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((line, i) => {
    const row = JSON.parse(line);
    const missing = ["id", "prompt", "fixture", "grade", "split"].filter((k) => typeof row[k] !== "string" || !row[k]);
    if (missing.length) throw new Error(`${file}:${i + 1}: missing ${missing.join(", ")}`);
    return { ...row, fixture: resolve(base, row.fixture) };
  });
}

/** Environment for a pinned run: never routed through laya-claude's sentinel. */
function pinnedEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === "ANTHROPIC_MODEL" || k.startsWith("ANTHROPIC_CUSTOM_MODEL_OPTION")) delete env[k];
  return env;
}

/** Runs one prompt on one tier in a fresh fixture copy; true when the grade command passes. */
export function runTier(row, tier, { claude = "claude", claudeArgs = DEFAULT_CLAUDE_ARGS, timeoutMs = 600000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `laya-synth-${tier}-`));
  const started = Date.now();
  try {
    cpSync(row.fixture, dir, { recursive: true });
    const run = spawnSync(claude, ["-p", row.prompt, "--model", MODELS[tier], ...claudeArgs], {
      cwd: dir,
      env: pinnedEnv(),
      stdio: "ignore",
      timeout: timeoutMs,
    });
    if (run.error) return { tier, passed: false, error: run.error.message, ms: Date.now() - started };
    const grade = spawnSync("sh", ["-c", row.grade], { cwd: dir, stdio: "ignore", timeout: timeoutMs });
    return { tier, passed: grade.status === 0, ms: Date.now() - started };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Cheapest passing tier, or null when no tier passes (such prompts are left out of the data). */
export function label(row, opts) {
  const runs = [];
  for (const tier of ORDER) {
    const r = runTier(row, tier, opts);
    runs.push(r);
    if (r.passed) return { label: tier, runs };
  }
  return { label: null, runs };
}

function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      out: { type: "string", default: "eval/data/synthetic.jsonl" },
      execute: { type: "boolean", default: false },
      claude: { type: "string", default: "claude" },
      "claude-args": { type: "string" },
      "timeout-ms": { type: "string", default: "600000" },
    },
  });
  if (!values.input) {
    console.error("usage: node eval/validate_synthetic.mjs --input prompts.jsonl [--execute] [--out FILE]");
    process.exit(2);
  }
  const rows = loadPrompts(values.input);
  const opts = {
    claude: values.claude,
    claudeArgs: values["claude-args"] ? values["claude-args"].split(" ").filter(Boolean) : DEFAULT_CLAUDE_ARGS,
    timeoutMs: Number(values["timeout-ms"]),
  };

  if (!values.execute) {
    console.log(`DRY RUN: ${rows.length} prompts, between ${rows.length} and ${rows.length * ORDER.length} billed \`claude -p\` runs.`);
    console.log(`Tiers in order: ${ORDER.map((t) => `${t} (${MODELS[t]})`).join(", ")}; stops at the first pass.`);
    console.log(`Claude arguments: ${opts.claudeArgs.join(" ")}\n`);
    for (const r of rows) console.log(`  ${r.id}: fixture ${r.fixture}, grade \`${r.grade}\``);
    console.log("\nNothing was run. Add --execute to make the runs.");
    return;
  }

  const out = [];
  for (const row of rows) {
    const { label: tier, runs } = label(row, opts);
    console.log(`${row.id}: ${tier ?? "unresolved"} (${runs.map((r) => `${r.tier}:${r.passed ? "pass" : "fail"}`).join(" ")})`);
    if (!tier) continue;
    out.push({ id: row.id, prompt: row.prompt, label: tier, source: "synthetic", license: "Apache-2.0", split: row.split, grade: row.grade, runs });
  }
  writeFileSync(values.out, out.map((r) => JSON.stringify(r)).join("\n") + (out.length ? "\n" : ""));
  console.log(`\n${out.length}/${rows.length} labelled -> ${values.out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
