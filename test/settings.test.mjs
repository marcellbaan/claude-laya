import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearStaleSentinel, restoreModel } from "../src/settings.mjs";

const tempSettings = (settings) => {
  const file = join(mkdtempSync(join(tmpdir(), "laya-settings-")), "settings.json");
  if (settings) writeFileSync(file, JSON.stringify(settings));
  return file;
};
const read = (file) => JSON.parse(readFileSync(file, "utf8"));

test("a sentinel left by a killed launcher is removed at startup, not kept as the default", () => {
  const file = tempSettings({ model: "laya-router", theme: "dark" });
  assert.equal(clearStaleSentinel(file), undefined);
  assert.deepEqual(read(file), { theme: "dark" });
});

test("the user's own default is returned and left untouched", () => {
  const file = tempSettings({ model: "opus" });
  assert.equal(clearStaleSentinel(file), "opus");
  assert.deepEqual(read(file), { model: "opus" });
});

test("a missing settings file is not created", () => {
  const file = tempSettings(null);
  assert.equal(clearStaleSentinel(file), undefined);
  assert.throws(() => readFileSync(file));
});

test("restoreModel puts back the previous default, or removes the key", () => {
  const withBefore = tempSettings({ model: "laya-router", theme: "dark" });
  restoreModel(withBefore, "opus");
  assert.deepEqual(read(withBefore), { model: "opus", theme: "dark" });

  const withoutBefore = tempSettings({ model: "laya-router" });
  restoreModel(withoutBefore, undefined);
  assert.deepEqual(read(withoutBefore), {});
});

test("restoreModel leaves a model the user chose during the session", () => {
  const file = tempSettings({ model: "sonnet" });
  restoreModel(file, "opus");
  assert.deepEqual(read(file), { model: "sonnet" });
});
