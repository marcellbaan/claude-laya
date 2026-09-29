import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import { MODELS, SENTINEL, startProxy } from "../src/proxy.mjs";
import { jsonUsage, sseUsage } from "../src/usage.mjs";
import { missingPrices, report } from "../eval/usage-report.mjs";

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const STREAM =
  sse("message_start", { message: { usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 1 } } }) +
  sse("content_block_delta", { delta: { type: "text_delta", text: "héllo ✓ wörld" } }) +
  sse("message_delta", { usage: { output_tokens: 42 } }) +
  sse("message_stop", {});
const EXPECTED = { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 42 };

test("SSE usage survives events and UTF-8 characters split across chunks", () => {
  const bytes = Buffer.from(STREAM);
  const check = bytes.indexOf(Buffer.from("✓"));
  // Cut inside the 3-byte ✓ and inside the message_delta event.
  const cuts = [7, check + 1, bytes.indexOf(Buffer.from("message_delta")) + 20];
  const parser = sseUsage();
  let from = 0;
  for (const cut of [...cuts, bytes.length]) {
    parser.write(bytes.subarray(from, cut));
    from = cut;
  }
  assert.deepEqual(parser.end(), EXPECTED);
});

test("a single byte at a time still parses", () => {
  const parser = sseUsage();
  for (const b of Buffer.from(STREAM)) parser.write(Buffer.from([b]));
  assert.deepEqual(parser.end(), EXPECTED);
});

test("non-streaming JSON usage is read from the body", () => {
  const parser = jsonUsage();
  parser.write(Buffer.from('{"usage":{"input_tokens":5,'));
  parser.write(Buffer.from('"output_tokens":7}}'));
  assert.deepEqual(parser.end(), { input_tokens: 5, output_tokens: 7 });
});

// Fake upstream that streams STREAM in uneven writes, optionally gzipped.
let gzip = false;
const upstream = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const body = gzip ? gzipSync(STREAM) : Buffer.from(STREAM);
    res.writeHead(200, { "content-type": "text/event-stream", ...(gzip && { "content-encoding": "gzip" }) });
    let i = 0;
    const step = () => {
      if (i >= body.length) return res.end();
      res.write(body.subarray(i, (i += 13)));
      setImmediate(step);
    };
    step();
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const usage = [];
const proxy = await startProxy({
  upstream: `http://127.0.0.1:${upstream.address().port}`,
  score: async () => ({ tier: "haiku", difficulty: 0.2, ms: 1 }),
  onUsage: (u) => usage.push(u),
});
after(() => (proxy.close(), upstream.close()));

/** Raw bytes as the client receives them (fetch would decompress gzip). */
function rawPost(body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxy.port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
const turn = { model: SENTINEL, tools: [{ name: "Bash", input_schema: {} }], messages: [{ role: "user", content: "fix the typo" }] };

test("the client receives the stream byte-for-byte while usage is recorded", async () => {
  gzip = false;
  usage.length = 0;
  assert.deepEqual(await rawPost(turn), Buffer.from(STREAM));
  await new Promise((r) => setImmediate(r));
  assert.equal(usage.length, 1);
  const [u] = usage;
  assert.deepEqual(u.usage, EXPECTED);
  assert.equal(u.tier, "haiku");
  assert.equal(u.model, MODELS.haiku);
  assert.equal(u.turn, 1);
  assert.match(u.conversation, /^[0-9a-f-]{36}$/);
  assert.doesNotMatch(JSON.stringify(u), /fix the typo/);
});

test("gzip responses pass through compressed and are still accounted", async () => {
  gzip = true;
  usage.length = 0;
  assert.deepEqual(await rawPost(turn), gzipSync(STREAM));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(usage.at(-1).usage, EXPECTED);
});

const PRICES = {
  cheap: { input: 1, output: 5, cache_write_5m: 1.25, cache_write_1h: 2, cache_read: 0.1 },
  big: { input: 10, output: 50, cache_write_5m: 12.5, cache_write_1h: 20, cache_read: 1 },
};

test("report prices each request at its model and at the always-opus counterfactual", () => {
  const records = [
    { conversation: "a", turn: 1, tier: "haiku", model: "cheap", usage: { input_tokens: 1e6, output_tokens: 1e6 } },
    { conversation: "a", turn: 1, tier: "haiku", model: "cheap", usage: { cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1e6 } } },
  ];
  const r = report(records, PRICES, "big");
  assert.equal(r.turns, 1);
  assert.equal(r.requests, 2);
  assert.equal(r.actual, 1 + 5 + 0.1 + 2);
  assert.equal(r.counterfactual, 10 + 50 + 1 + 20);
  assert.equal(r.unsplitWrites, 0);
});

test("cache writes without a TTL split are priced as 5-minute writes and counted", () => {
  const r = report([{ conversation: "a", turn: 1, tier: "haiku", model: "cheap", usage: { cache_creation_input_tokens: 1e6 } }], PRICES, "big");
  assert.equal(r.actual, 1.25);
  assert.equal(r.unsplitWrites, 1e6);
});

test("missingPrices lists every absent or invalid field", () => {
  assert.deepEqual(missingPrices({ cheap: { ...PRICES.cheap, output: null } }, ["cheap", "big"]), [
    "cheap.output",
    ...["input", "output", "cache_write_5m", "cache_write_1h", "cache_read"].map((f) => `big.${f}`),
  ]);
});

test("the report CLI refuses to run on the shipped empty price template", () => {
  const dir = mkdtempSync(join(tmpdir(), "laya-usage-"));
  const log = join(dir, "usage.jsonl");
  writeFileSync(log, `${JSON.stringify({ conversation: "a", turn: 1, tier: "haiku", model: MODELS.haiku, usage: { input_tokens: 1 } })}\n`);
  const run = spawnSync(process.execPath, ["eval/usage-report.mjs", "--usage", log, "--prices", "eval/prices.example.json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, new RegExp(`${MODELS.haiku}\\.input`));
  assert.match(run.stderr, new RegExp(`${MODELS.opus}\\.cache_read`));
});
