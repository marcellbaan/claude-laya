// Loopback proxy between Claude Code and the Anthropic API. Requests for the sentinel model
// get a real model id chosen per turn; everything else passes through untouched. Auth headers
// are forwarded as-is to the upstream only, and nothing about a prompt is written anywhere.
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";

/** Model id Claude Code sends when "Laya Router" is selected in /model. */
export const SENTINEL = "laya-router";

export const ORDER = ["haiku", "sonnet", "opus"];
export const MODELS = {
  haiku: process.env.LAYA_HAIKU_MODEL ?? "claude-haiku-4-5-20251001",
  sonnet: process.env.LAYA_SONNET_MODEL ?? "claude-sonnet-5-5",
  opus: process.env.LAYA_OPUS_MODEL ?? "claude-opus-5-5",
};

/** Used when there is nothing to go on (Laya down, or a conversation we have not seen). */
const FALLBACK = "opus";

/**
 * Switching model discards the prompt cache, so a downgrade stops paying for itself once the
 * conversation is large. Tokens are estimated as characters / 4.
 */
const DOWNGRADE_MAX_TOKENS = Number(process.env.LAYA_DOWNGRADE_MAX_TOKENS ?? 20000);

const OVERRIDE = /\b(?:use|switch to|with|on)\s+(haiku|sonnet|opus)\b/i;

/**
 * Text of a new user turn, or null. Tool-loop continuations end in a tool_result and keep the
 * turn's model. Calls without tools are Claude Code's own helpers (titles, summaries). Newer
 * Claude Code appends `system` messages (hook output) after the prompt, so those are skipped.
 */
export function newTurnPrompt(body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return null;
  const last = body.messages?.findLast((m) => m.role !== "system");
  if (last?.role !== "user") return null;
  const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
  if (!Array.isArray(blocks) || blocks.some((b) => b.type === "tool_result")) return null;
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() || null;
}

/**
 * Identifies a conversation by its first message, which Claude Code resends verbatim on every
 * request. Sub-agents start with a different first message, so they are pinned separately.
 */
export const conversationKey = (body) =>
  createHash("sha256").update(JSON.stringify(body.messages?.[0] ?? null)).digest("hex").slice(0, 16);

/**
 * Claude Code builds the body for a model with adaptive thinking and effort. Haiku accepts
 * neither, nor a context edit that prunes thinking blocks.
 */
export function applyTier(body, tier) {
  body.model = MODELS[tier];
  if (tier !== "haiku") return body;
  delete body.thinking;
  const edits = body.context_management?.edits;
  if (Array.isArray(edits)) {
    body.context_management.edits = edits.filter((e) => !/thinking/i.test(e?.type ?? ""));
    if (body.context_management.edits.length === 0) delete body.context_management;
  }
  if (body.output_config) {
    delete body.output_config.effort;
    if (Object.keys(body.output_config).length === 0) delete body.output_config;
  }
  return body;
}

/**
 * Claude Code normalises draft-04 MCP tool schemas only when talking to Anthropic directly,
 * not behind a custom base URL, and the API rejects boolean exclusiveMinimum/Maximum.
 */
export function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.forEach(sanitizeSchema);
  if (!node || typeof node !== "object") return;
  for (const [key, bound] of [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]]) {
    if (typeof node[key] !== "boolean") continue;
    if (node[key] && typeof node[bound] === "number") {
      node[key] = node[bound];
      delete node[bound];
    } else {
      delete node[key];
    }
  }
  for (const v of Object.values(node)) sanitizeSchema(v);
}

/**
 * Picks the tier for one request. `previous` is the tier this conversation used last.
 * @returns {Promise<{tier: string, reason: string, difficulty?: number, ms?: number}>}
 */
export async function decide(body, previous, score) {
  const prompt = newTurnPrompt(body);
  if (!prompt) return { tier: previous ?? FALLBACK, reason: previous ? "continuation" : "unknown" };
  const override = prompt.match(OVERRIDE)?.[1]?.toLowerCase();
  if (override) return { tier: override, reason: "override" };

  // A conversation this process has not seen (e.g. `--resume`) still has a prompt cache
  // built on some model, so the downgrade guard assumes the fallback rather than skipping.
  const current = previous ?? FALLBACK;
  const scored = await score(prompt);
  if (!scored) return { tier: current, reason: "laya-unavailable" };
  const rank = (t) => ORDER.indexOf(t);
  const tokens = JSON.stringify(body.messages).length / 4;
  if (rank(scored.tier) < rank(current) && tokens > DOWNGRADE_MAX_TOKENS) {
    return { ...scored, tier: current, reason: "kept-cache" };
  }
  return { ...scored, reason: "laya" };
}

const HOP_BY_HOP = ["host", "connection", "content-length", "keep-alive", "transfer-encoding"];

/**
 * @param {object} opts
 * @param {string} opts.upstream  API base URL requests are forwarded to
 * @param {(prompt: string) => Promise<?object>} opts.score
 * @param {(decision: object) => void} [opts.onDecision]  receives tier/reason/difficulty only
 */
export function startProxy({ upstream = "https://api.anthropic.com", score, onDecision = () => {} }) {
  const base = new URL(upstream);
  const transport = base.protocol === "https:" ? https : http;
  const tiers = new Map(); // conversation key -> last tier

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let payload = Buffer.concat(chunks);
      try {
        payload = await rewrite(req, payload);
      } catch {
        // Not JSON we understand: forward exactly what Claude Code sent.
      }
      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(([k]) => !HOP_BY_HOP.includes(k.toLowerCase())),
      );
      if (payload.length) headers["content-length"] = payload.length;
      const path = base.pathname.replace(/\/$/, "") + req.url;
      const up = transport.request({ hostname: base.hostname, port: base.port, path, method: req.method, headers }, (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
      });
      up.on("error", (err) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `laya-claude proxy: ${err.message}` } }));
      });
      up.end(payload);
    });
  });

  async function rewrite(req, payload) {
    if (req.method !== "POST" || req.headers["content-encoding"] || !payload.length) return payload;
    const body = JSON.parse(payload);
    sanitizeSchema(body.tools?.map((t) => t.input_schema));
    if (body.model === SENTINEL) {
      const key = conversationKey(body);
      // Only real turns are scored; token counting and the like reuse the conversation's tier.
      const isTurn = /^\/v1\/messages(\?|$)/.test(req.url);
      const decision = isTurn
        ? await decide(body, tiers.get(key), score)
        : { tier: tiers.get(key) ?? FALLBACK, reason: "auxiliary" };
      if (isTurn) {
        tiers.set(key, decision.tier);
        if (tiers.size > 1000) tiers.delete(tiers.keys().next().value);
        if (decision.reason !== "continuation") onDecision(decision);
      }
      applyTier(body, decision.tier);
    }
    return Buffer.from(JSON.stringify(body));
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => server.close() }));
  });
}
