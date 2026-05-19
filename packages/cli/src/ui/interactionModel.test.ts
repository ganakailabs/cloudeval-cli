import assert from "node:assert/strict";
import test from "node:test";
import {
  chatPanelFocusForControl,
  getSelectorControlHitAreas,
  selectorControlFromMousePosition,
  buildControlFocusOrder,
  focusFollowUpIndex,
  isPromptTextInput,
  nextControlFocus,
  type TuiControlFocus,
} from "./interactionModel";

test("buildControlFocusOrder includes reasoning and each follow-up after selectors", () => {
  assert.deepEqual(buildControlFocusOrder({ hasThinkingSteps: true, followUpCount: 2 }), [
    "thread",
    "project",
    "model",
    "mode",
    "profile",
    "thinking",
    "threadPanel",
    "followup:0",
    "followup:1",
  ]);
});

test("nextControlFocus cycles through dynamic controls", () => {
  const order = buildControlFocusOrder({ hasThinkingSteps: true, followUpCount: 1 });
  assert.equal(nextControlFocus("thread", order), "project");
  assert.equal(nextControlFocus("project", order), "model");
  assert.equal(nextControlFocus("mode", order), "profile");
  assert.equal(nextControlFocus("profile", order), "thinking");
  assert.equal(nextControlFocus("thinking", order), "threadPanel");
  assert.equal(nextControlFocus("threadPanel", order), "followup:0");
  assert.equal(nextControlFocus("followup:0", order), "thread");
  assert.equal(nextControlFocus("project", order, -1), "thread");
});

test("nextControlFocus falls back safely when current control disappears", () => {
  const order = buildControlFocusOrder({ hasThinkingSteps: false, followUpCount: 0 });
  assert.equal(nextControlFocus("followup:3" as TuiControlFocus, order), "thread");
});

test("focusFollowUpIndex extracts button index", () => {
  assert.equal(focusFollowUpIndex("followup:2"), 2);
  assert.equal(focusFollowUpIndex("thinking"), undefined);
});

test("chatPanelFocusForControl maps focused controls to panel borders", () => {
  assert.equal(chatPanelFocusForControl("project"), "settings");
  assert.equal(chatPanelFocusForControl("thinking"), "settings");
  assert.equal(chatPanelFocusForControl("followup:0"), "prompt");
  assert.equal(chatPanelFocusForControl("threadPanel"), "thread");
});

test("maps row-layout selector dropdown clicks to controls", () => {
  const areas = getSelectorControlHitAreas({
    compact: false,
    hasThinkingSteps: true,
    startColumn: 2,
    startRow: 14,
    terminalColumns: 150,
  });

  assert.deepEqual(areas[0], {
    target: "thread",
    startColumn: 2,
    endColumn: 29,
    startRow: 14,
    endRow: 16,
  });
  assert.deepEqual(areas[1], {
    target: "project",
    startColumn: 31,
    endColumn: 58,
    startRow: 14,
    endRow: 16,
  });
  assert.equal(selectorControlFromMousePosition({ x: 6, y: 15 }, areas), "thread");
  assert.equal(selectorControlFromMousePosition({ x: 34, y: 15 }, areas), "project");
  assert.equal(selectorControlFromMousePosition({ x: 62, y: 15 }, areas), "model");
  assert.equal(selectorControlFromMousePosition({ x: 86, y: 15 }, areas), "mode");
  assert.equal(selectorControlFromMousePosition({ x: 104, y: 15 }, areas), "profile");
  assert.equal(selectorControlFromMousePosition({ x: 128, y: 15 }, areas), "thinking");
  assert.equal(selectorControlFromMousePosition({ x: 34, y: 18 }, areas), undefined);
});

test("maps compact stacked selector dropdown clicks to controls", () => {
  const areas = getSelectorControlHitAreas({
    compact: true,
    hasThinkingSteps: false,
    startColumn: 1,
    startRow: 12,
    terminalColumns: 80,
  });

  assert.equal(selectorControlFromMousePosition({ x: 12, y: 13 }, areas), "thread");
  assert.equal(selectorControlFromMousePosition({ x: 12, y: 14 }, areas), "project");
  assert.equal(selectorControlFromMousePosition({ x: 12, y: 16 }, areas), "model");
  assert.equal(selectorControlFromMousePosition({ x: 12, y: 17 }, areas), "mode");
  assert.equal(selectorControlFromMousePosition({ x: 12, y: 18 }, areas), "profile");
  assert.equal(selectorControlFromMousePosition({ x: 12, y: 15 }, areas), undefined);
  assert.equal(selectorControlFromMousePosition({ x: 12, y: 19 }, areas), undefined);
});

test("maps compact thinking clicks under the activity section", () => {
  const areas = getSelectorControlHitAreas({
    compact: true,
    hasThinkingSteps: true,
    startColumn: 1,
    startRow: 12,
    terminalColumns: 80,
  });

  assert.equal(selectorControlFromMousePosition({ x: 12, y: 20 }, areas), "thinking");
});

test("isPromptTextInput accepts printable text and rejects navigation keys", () => {
  assert.equal(isPromptTextInput("a", {}), true);
  assert.equal(isPromptTextInput("/", {}), true);
  assert.equal(isPromptTextInput("", {}), false);
  assert.equal(isPromptTextInput("2", { ctrl: true }), false);
  assert.equal(isPromptTextInput("2", { meta: true }), false);
  assert.equal(isPromptTextInput("", { return: true }), false);
  assert.equal(isPromptTextInput("\t", { tab: true }), false);
  assert.equal(isPromptTextInput("", { escape: true }), false);
  assert.equal(isPromptTextInput("", { leftArrow: true }), false);
  assert.equal(isPromptTextInput("\u007f", { backspace: true }), false);
});
