import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, beforeEach, test } from "node:test";
import { MODELS, SENTINEL, newTurnPrompt, sanitizeSchema, startProxy } from "../src/proxy.mjs";

// Fake Anthropic API: records what arrived, replies with a short SSE stream.
const received = [];
const upstream = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    received.push({ url: req.url, headers: req.headers, raw, body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: message_start\ndata: {}\n\n");
    res.end("event: message_stop\ndata: {}\n\n");
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

let next = null; // what the fake scorer answers
const scored = [];
const decisions = [];
const proxy = await startProxy({
  upstream: `http://127.0.0.1:${upstream.address().port}`,
  score: async (prompt) => (scored.push(prompt), next),
  onDecision: (d) => decisions.push(d),
});
after(() => (proxy.close(), upstream.close()));
beforeEach(() => (received.length = scored.length = decisions.length = 0));

const TOOLS = [{ name: "Bash", input_schema: { type: "object" } }];
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const turn = (first, ...more) => ({
  model: SENTINEL,
  tools: TOOLS,
  thinking: { type: "adaptive" },
  output_config: { effort: "high" },
  messages: [user(first), ...more],
});

async function send(body, path = "/v1/messages") {
  const res = await fetch(`http://127.0.0.1:${proxy.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret-token", "anthropic-beta": "x" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text(), got: received.at(-1) };
}

test("a new turn is scored and sent to that tier's model, with auth forwarded", async () => {
  next = { tier: "sonnet", difficulty: 0.42, ms: 30 };
  const { status, text, got } = await send(turn("add a --verbose flag"));
  assert.equal(status, 200);
  assert.match(text, /message_stop/);
  assert.equal(got.body.model, MODELS.sonnet);
  assert.deepEqual(got.body.thinking, { type: "adaptive" });
  assert.equal(got.headers.authorization, "Bearer secret-token");
  assert.equal(got.headers["anthropic-beta"], "x");
  assert.deepEqual(scored, ["add a --verbose flag"]);
});

test("decisions carry no prompt text", async () => {
  next = { tier: "opus", difficulty: 0.6, ms: 30 };
  await send(turn("SECRET PROMPT TEXT"));
  assert.deepEqual(decisions, [{ tier: "opus", difficulty: 0.6, ms: 30, reason: "laya" }]);
  assert.doesNotMatch(JSON.stringify(decisions), /SECRET/);
});

test("haiku gets thinking, effort and thinking context edits removed", async () => {
  next = { tier: "haiku", difficulty: 0.2, ms: 30 };
  const body = turn("fix the typo");
  body.context_management = { edits: [{ type: "clear_thinking_20251015" }] };
  const { got } = await send(body);
  assert.equal(got.body.model, MODELS.haiku);
  assert.equal(got.body.thinking, undefined);
  assert.equal(got.body.output_config, undefined);
  assert.equal(got.body.context_management, undefined);
});

test("tool-loop continuations keep the turn's model without re-scoring", async () => {
  next = { tier: "haiku", difficulty: 0.2, ms: 30 };
  await send(turn("run the tests"));
  next = { tier: "opus", difficulty: 0.9, ms: 30 };
  const { got } = await send(turn("run the tests",
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }));
  assert.equal(got.body.model, MODELS.haiku);
  assert.equal(scored.length, 1);
});

test("a trailing system message (hook output) does not hide the user turn", async () => {
  next = { tier: "haiku", difficulty: 0.2, ms: 30 };
  const { got } = await send(turn("what is 2+2?", { role: "system", content: [{ type: "text", text: "hook" }] }));
  assert.equal(got.body.model, MODELS.haiku);
  assert.deepEqual(scored, ["what is 2+2?"]);
});

test("'use opus' at the start of the prompt overrides Laya", async () => {
  next = { tier: "haiku", difficulty: 0.2, ms: 30 };
  const { got } = await send(turn("use opus: rename x"));
  assert.equal(got.body.model, MODELS.opus);
  assert.equal(scored.length, 0);
});

test("Laya being down falls back to opus", async () => {
  next = null;
  const { got } = await send(turn("anything"));
  assert.equal(got.body.model, MODELS.opus);
});

test("no downgrade once the conversation is large (prompt cache)", async () => {
  const big = "x".repeat(100_000);
  next = { tier: "opus", difficulty: 0.9, ms: 30 };
  await send(turn(big));
  next = { tier: "haiku", difficulty: 0.1, ms: 30 };
  const { got } = await send(turn(big, { role: "assistant", content: [{ type: "text", text: "done" }] }, user("thanks")));
  assert.equal(got.body.model, MODELS.opus);
});

test("a model picked by the user passes through byte-for-byte", async () => {
  const raw = JSON.stringify({ model: "claude-opus-5-5", tools: TOOLS, messages: [user("hi")] });
  const { got } = await send(raw);
  assert.equal(got.raw, raw);
  assert.equal(scored.length, 0);
});

test("count_tokens with the sentinel gets a real model but is not scored", async () => {
  const { got } = await send({ model: SENTINEL, messages: [user("hi")] }, "/v1/messages/count_tokens");
  assert.equal(got.url, "/v1/messages/count_tokens");
  assert.notEqual(got.body.model, SENTINEL);
  assert.equal(scored.length, 0);
});

test("newTurnPrompt strips system reminders and ignores tool-less helper calls", () => {
  const body = { tools: TOOLS, messages: [user("<system-reminder>ctx</system-reminder>\ndo it")] };
  assert.equal(newTurnPrompt(body), "do it");
  assert.equal(newTurnPrompt({ ...body, tools: [] }), null);
});

test("sanitizeSchema converts draft-04 boolean exclusive bounds", () => {
  const s = { properties: { n: { minimum: 1, exclusiveMinimum: true }, m: { exclusiveMaximum: false } } };
  sanitizeSchema(s);
  assert.deepEqual(s, { properties: { n: { exclusiveMinimum: 1 }, m: {} } });
});

test("a resumed large conversation (no remembered tier) is not downgraded", async () => {
  const { decide } = await import("../src/proxy.mjs");
  const body = { model: SENTINEL, tools: TOOLS, messages: [user("x".repeat(100_000)), { role: "assistant", content: "ok" }, user("thanks")] };
  const d = await decide(body, undefined, async () => ({ tier: "haiku", difficulty: 0.1, ms: 1 }));
  assert.equal(d.tier, "opus");
  assert.equal(d.reason, "kept-cache");
});

test("a small conversation with no remembered tier still follows Laya", async () => {
  const { decide } = await import("../src/proxy.mjs");
  const d = await decide(turn("fix the typo"), undefined, async () => ({ tier: "haiku", difficulty: 0.1, ms: 1 }));
  assert.equal(d.tier, "haiku");
  assert.equal(d.reason, "laya");
});

test("overrides are anchored to the start of the prompt", async () => {
  const { decide } = await import("../src/proxy.mjs");
  const laya = async () => ({ tier: "sonnet", difficulty: 0.4, ms: 1 });
  for (const text of ["why did the job run on haiku?", "rename x, use opus", "we use sonnet in prod"]) {
    assert.equal((await decide(turn(text), "sonnet", laya)).reason, "laya", text);
  }
  assert.equal((await decide(turn("  Switch to HAIKU and rename x"), "sonnet", laya)).tier, "haiku");
});

test("an override upgrade applies at any conversation size", async () => {
  const { decide } = await import("../src/proxy.mjs");
  const big = turn("x".repeat(100_000), { role: "assistant", content: "ok" }, user("use opus: now fix it"));
  assert.deepEqual(await decide(big, "haiku", async () => null), { tier: "opus", reason: "override" });
});

test("an override downgrade applies when small and is refused when large", async () => {
  const { decide } = await import("../src/proxy.mjs");
  assert.deepEqual(await decide(turn("use haiku: rename x"), "opus", async () => null), { tier: "haiku", reason: "override" });
  const big = turn("x".repeat(100_000), { role: "assistant", content: "ok" }, user("use haiku: rename x"));
  assert.deepEqual(await decide(big, "opus", async () => null), { tier: "opus", reason: "override-kept-cache" });
});
