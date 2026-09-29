#!/usr/bin/env node
// Claude Code status line: which model the last turn was routed to, and why.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

let session = {};
try {
  session = JSON.parse(readFileSync(0, "utf8"));
} catch {
  // No stdin JSON; still show the routing part.
}

let routed = "laya: waiting for first turn";
try {
  const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const score = Number.isFinite(d.difficulty) ? ` d=${d.difficulty.toFixed(2)}` : "";
  routed = `⚡ ${d.tier}${score}${d.reason === "laya" ? "" : ` (${d.reason})`}`;
} catch {
  // No decision yet.
}

// Selecting a concrete model in /model bypasses the router.
const picked = session.model?.id;
if (picked && picked !== "laya-router") routed = `⏸ manual ${session.model.display_name ?? picked}`;

const dir = session.workspace?.current_dir ?? session.cwd;
console.log([routed, dir && basename(dir)].filter(Boolean).join(" · "));
