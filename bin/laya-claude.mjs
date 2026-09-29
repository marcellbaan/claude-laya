#!/usr/bin/env node
// Runs Claude Code behind a local proxy that routes each turn to haiku, sonnet or opus,
// with the decision made by a local Laya server. All arguments are passed to `claude`.
import { spawn } from "node:child_process";
import { accessSync, appendFileSync, chmodSync, constants, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAYA_URL, score } from "../src/score.mjs";
import { SENTINEL, startProxy } from "../src/proxy.mjs";
import { clearStaleSentinel, restoreModel } from "../src/settings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(homedir(), ".laya-claude");
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
chmodSync(STATE_DIR, 0o700); // `mode` above only applies when the directory is created
const STATUS_FILE = join(STATE_DIR, `status-${process.pid}.json`);
const DEBUG_FILE = join(STATE_DIR, "debug.log");

const warn = (message) => process.stderr.write(`[laya] ${message}\n`);

function which(name, extra = []) {
  for (const dir of [...(process.env.PATH ?? "").split(":"), ...extra]) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {
      // Keep looking.
    }
  }
  return null;
}

const healthy = () => fetch(`${LAYA_URL}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);

/**
 * Starts laya-serve in the background if it is not answering, and leaves it running so later
 * sessions skip the checkpoint load. It gets an allow-listed environment, not ours.
 */
async function ensureLaya() {
  if (await healthy()) return;
  const url = new URL(LAYA_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) return warn(`Laya at ${LAYA_URL} is not answering`);
  const bin = which("laya-serve", [join(homedir(), ".local", "bin")]);
  if (!bin) return warn('laya-serve not found; install it with: uv tool install --python 3.12 "laya[serve]"');

  const env = { LAYA_PRELOAD: "1", LAYA_MODELS: "english,multilingual" };
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(PATH|HOME|TMPDIR|LANG|LC_\w+|HF_HOME|HF_HUB_OFFLINE|LAYA_\w+)$/.test(k)) env[k] = v;
  }
  Object.assign(env, { LAYA_HOST: url.hostname, LAYA_PORT: url.port || "80" });
  const logFile = join(STATE_DIR, "laya-serve.log");
  spawn(bin, [], { detached: true, stdio: ["ignore", openSync(logFile, "a", 0o600), openSync(logFile, "a", 0o600)], env }).unref();

  warn(`starting laya-serve (log: ${logFile}) ...`);
  const deadline = Date.now() + Number(process.env.LAYA_START_TIMEOUT_MS ?? 300000);
  while (Date.now() < deadline) {
    if (await healthy()) return warn("ready");
    await new Promise((r) => setTimeout(r, 1000));
  }
  warn(`laya-serve did not start; turns stay on opus. See ${logFile}`);
}

/** Only tier, reason and scores are recorded: never prompt text. */
function onDecision(decision) {
  const line = { at: new Date().toISOString(), ...decision };
  try {
    writeFileSync(STATUS_FILE, JSON.stringify(line), { mode: 0o600 });
    if (process.env.LAYA_DEBUG) appendFileSync(DEBUG_FILE, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    // Status is cosmetic; never let it break a request.
  }
}

function readJSON(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Adds our status line unless the user already configured one. */
function statusLineArgs() {
  const configured = [
    join(process.cwd(), ".claude", "settings.local.json"),
    join(process.cwd(), ".claude", "settings.json"),
    join(homedir(), ".claude", "settings.json"),
  ].some((f) => readJSON(f)?.statusLine);
  if (configured || process.env.LAYA_NO_STATUSLINE) return [];
  const command = `"${process.execPath}" "${join(HERE, "statusline.mjs")}" "${STATUS_FILE}"`;
  const file = join(STATE_DIR, `settings-${process.pid}.json`);
  writeFileSync(file, JSON.stringify({ statusLine: { type: "command", command } }), { mode: 0o600 });
  return ["--settings", file];
}

const claude = which("claude");
if (!claude) {
  warn("Claude Code (`claude`) is not on your PATH");
  process.exit(1);
}

await ensureLaya();

const USER_SETTINGS = join(homedir(), ".claude", "settings.json");
const modelBefore = clearStaleSentinel(USER_SETTINGS);

const proxy = await startProxy({ upstream: process.env.ANTHROPIC_BASE_URL, score, onDecision });
const args = [...process.argv.slice(2), ...statusLineArgs()];
const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
  ANTHROPIC_CUSTOM_MODEL_OPTION: SENTINEL,
  ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Laya Router",
  ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Route each turn to the cheapest model that can do it (local Laya)",
  ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "thinking,adaptive_thinking,interleaved_thinking,effort,max_effort",
  CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? SENTINEL,
};

const child = spawn(claude, args, { stdio: "inherit", env });
// Ctrl-C belongs to Claude Code; the launcher just waits for it to exit.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  proxy.close();
  restoreModel(USER_SETTINGS, modelBefore);
  rmSync(STATUS_FILE, { force: true });
  rmSync(join(STATE_DIR, `settings-${process.pid}.json`), { force: true });
  process.exit(signal ? 1 : (code ?? 0));
});
