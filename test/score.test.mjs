import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";

// Fake Laya server, started before score.mjs reads LAYA_URL.
let reply = null;
let lastBody = null;
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    lastBody = JSON.parse(raw || "{}");
    res.writeHead(reply ? 200 : 500, { "content-type": "application/json" });
    res.end(JSON.stringify(reply ?? {}));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.LAYA_URL = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const { difficulty, score, tierFor } = await import("../src/score.mjs");

const answers = (p, task, reasoning) => ({
  model_tier: { type: "choice", choice: "haiku", probabilities: p },
  task_complexity: { type: "score", score: task },
  reasoning_required: { type: "score", score: reasoning },
});

test("difficulty averages the choice's expected rank with both scores", () => {
  assert.equal(difficulty(answers({ haiku: 1, sonnet: 0, opus: 0 }, 0, 0)), 0);
  assert.equal(difficulty(answers({ haiku: 0, sonnet: 0, opus: 1 }, 9, 9)), 1);
});

test("tierFor applies the cut points", () => {
  assert.equal(tierFor(0.2), "haiku");
  assert.equal(tierFor(0.375), "sonnet");
  assert.equal(tierFor(0.5), "opus");
});

test("score sends only the prompt and returns the tier", async () => {
  reply = { answers: answers({ haiku: 0.1, sonnet: 0.2, opus: 0.7 }, 6, 6) };
  const r = await score("find the race");
  assert.equal(r.tier, "opus");
  assert.deepEqual(lastBody.state, { request: "find the race" });
});

test("score returns null when Laya errors", async () => {
  reply = null;
  assert.equal(await score("hi"), null);
});
