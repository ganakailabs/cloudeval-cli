import assert from "node:assert/strict";
import test from "node:test";
import { getChatInputHelpText, getTuiKeyBindings } from "./keyBindings";

test("getTuiKeyBindings uses macOS naming for multiline input", () => {
  assert.match(getTuiKeyBindings("darwin").newline, /Option\+Enter/);
  assert.equal(
    getTuiKeyBindings("darwin").commandComplete,
    "Tab/↑↓ slash command menu"
  );
});

test("getTuiKeyBindings uses Alt naming for non-macOS multiline input", () => {
  assert.match(getTuiKeyBindings("linux").newline, /Alt\+Enter/);
  assert.match(getTuiKeyBindings("win32").newline, /Alt\+Enter/);
});

test("getChatInputHelpText stays short and avoids duplicate settings shortcuts", () => {
  const idleText = getChatInputHelpText({ isCancelling: false, promptCount: 4 });
  const idleWithoutPromptsText = getChatInputHelpText({
    isCancelling: false,
    promptCount: 0,
  });
  const blurredText = getChatInputHelpText({
    isCancelling: false,
    inputActive: false,
    promptCount: 4,
  });
  const cancellingText = getChatInputHelpText({ isCancelling: true });

  assert.equal(
    idleText,
    "Enter send/choose | Esc controls | /copy | Tab focus | /help"
  );
  assert.equal(
    idleWithoutPromptsText,
    "Enter send | Esc controls | /copy | /download | /help"
  );
  assert.equal(
    blurredText,
    "Type to edit | Tab/Arrows controls | 1-8 tabs | /help"
  );
  assert.equal(cancellingText, "Esc stop | Ctrl+C quit | /stop | /help");
  assert.ok(idleText.length < 82);
  assert.doesNotMatch(idleText, /\/project|\/model|\/mode|\/thinking|history|Option|prompts/);
});
