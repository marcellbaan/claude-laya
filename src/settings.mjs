// Keeps Claude Code's saved default model usable by plain `claude`. Picking "Laya Router" with
// Enter in /model saves the sentinel as the default, and outside laya-claude it is not a model.
import { readFileSync, writeFileSync } from "node:fs";
import { SENTINEL } from "./proxy.mjs";

function read(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const write = (file, settings) => writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);

/**
 * Run at startup. A sentinel left behind by a launcher that was killed (SIGKILL, crash) is
 * removed, and never mistaken for the user's own choice.
 * @returns {string|undefined} the user's real default model, to restore on exit
 */
export function clearStaleSentinel(file) {
  const settings = read(file);
  if (settings?.model !== SENTINEL) return settings?.model;
  delete settings.model;
  write(file, settings);
  return undefined;
}

/** Run at exit: if this session saved the sentinel as the default, put the old value back. */
export function restoreModel(file, before) {
  const settings = read(file);
  if (settings?.model !== SENTINEL) return;
  if (before === undefined) delete settings.model;
  else settings.model = before;
  write(file, settings);
}
