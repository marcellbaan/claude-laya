// Reads token usage from Anthropic responses as they stream past, without buffering or
// changing what the client receives: the tap only listens to the same chunks the pipe sends.
import { StringDecoder } from "node:string_decoder";
import zlib from "node:zlib";

const FIELDS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
const DECODERS = { gzip: zlib.createGunzip, br: zlib.createBrotliDecompress, deflate: zlib.createInflate };

function collector() {
  const usage = {};
  const take = (u) => {
    if (!u) return;
    for (const k of FIELDS) if (Number.isFinite(u[k])) usage[k] = u[k];
    // Split of cache writes by TTL (5m / 1h), which are priced differently.
    if (u.cache_creation) usage.cache_creation = { ...u.cache_creation };
  };
  return { usage, take };
}

/**
 * Incremental SSE parser. Events can be split anywhere across chunks, including inside a
 * multi-byte UTF-8 character. `message_start` carries input and cache counts; each
 * `message_delta` carries the running totals, so later values win.
 */
export function sseUsage() {
  const text = new StringDecoder("utf8");
  const { usage, take } = collector();
  let buf = "";
  const event = (raw) => {
    const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    let e;
    try {
      e = JSON.parse(data);
    } catch {
      return;
    }
    if (e.type === "message_start") take(e.message?.usage);
    else if (e.type === "message_delta") take(e.usage);
  };
  return {
    write(chunk) {
      buf += text.write(chunk);
      for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) event(buf.slice(0, i));
    },
    end() {
      buf += text.end();
      if (buf.trim()) event(buf);
      return usage;
    },
  };
}

/** Non-streaming responses: `usage` sits at the top level of the JSON body. */
export function jsonUsage() {
  const text = new StringDecoder("utf8");
  const { usage, take } = collector();
  let buf = "";
  return {
    write: (chunk) => void (buf += text.write(chunk)),
    end() {
      try {
        take(JSON.parse(buf + text.end()).usage);
      } catch {
        // Not JSON; no usage.
      }
      return usage;
    },
  };
}

/**
 * Listens to an upstream response and calls `onDone(usage)` when it ends, if it carried any.
 * Compressed bodies are decoded on a copy. Every failure here is swallowed: accounting must
 * never affect the response.
 */
export function tapUsage(res, onDone) {
  const type = String(res.headers["content-type"] ?? "");
  const parser = type.includes("text/event-stream") ? sseUsage() : type.includes("json") ? jsonUsage() : null;
  const encoding = res.headers["content-encoding"];
  if (!parser || (encoding && !DECODERS[encoding])) return;

  const finish = () => {
    try {
      const usage = parser.end();
      if (Object.keys(usage).length) onDone(usage);
    } catch {
      // Ignore.
    }
  };
  const feed = (chunk) => {
    try {
      parser.write(chunk);
    } catch {
      // Ignore.
    }
  };
  if (!encoding) {
    res.on("data", feed);
    res.on("end", finish);
    return;
  }
  const decoder = DECODERS[encoding]();
  decoder.on("data", feed);
  decoder.on("end", finish);
  decoder.on("error", () => {});
  res.on("data", (chunk) => decoder.write(chunk));
  res.on("end", () => decoder.end());
}
