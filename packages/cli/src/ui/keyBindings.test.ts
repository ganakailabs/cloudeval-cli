import assert from "node:assert/strict";
import test from "node:test";
import { getTuiKeyBindings } from "./keyBindings";

test("getTuiKeyBindings uses macOS naming for multiline input", () => {
  assert.match(getTuiKeyBindings("darwin").newline, /Option\+Enter/);
});

test("getTuiKeyBindings uses Alt naming for non-macOS multiline input", () => {
  assert.match(getTuiKeyBindings("linux").newline, /Alt\+Enter/);
  assert.match(getTuiKeyBindings("win32").newline, /Alt\+Enter/);
});
