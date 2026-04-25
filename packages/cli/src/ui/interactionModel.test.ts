import assert from "node:assert/strict";
import test from "node:test";
import {
  getSelectorControlHitAreas,
  selectorControlFromMousePosition,
  buildControlFocusOrder,
  focusFollowUpIndex,
  nextControlFocus,
  type TuiControlFocus,
} from "./interactionModel";

test("buildControlFocusOrder includes reasoning and each follow-up after selectors", () => {
  assert.deepEqual(buildControlFocusOrder({ hasThinkingSteps: true, followUpCount: 2 }), [
    "project",
    "model",
    "mode",
    "thinking",
    "followup:0",
    "followup:1",
  ]);
});

test("nextControlFocus cycles through dynamic controls", () => {
  const order = buildControlFocusOrder({ hasThinkingSteps: true, followUpCount: 1 });
  assert.equal(nextControlFocus("project", order), "model");
  assert.equal(nextControlFocus("thinking", order), "followup:0");
  assert.equal(nextControlFocus("followup:0", order), "project");
  assert.equal(nextControlFocus("project", order, -1), "followup:0");
});

test("nextControlFocus falls back safely when current control disappears", () => {
  const order = buildControlFocusOrder({ hasThinkingSteps: false, followUpCount: 0 });
  assert.equal(nextControlFocus("followup:3" as TuiControlFocus, order), "project");
});

test("focusFollowUpIndex extracts button index", () => {
  assert.equal(focusFollowUpIndex("followup:2"), 2);
  assert.equal(focusFollowUpIndex("thinking"), undefined);
});

test("maps row-layout selector dropdown clicks to controls", () => {
  const areas = getSelectorControlHitAreas({
    compact: false,
    hasThinkingSteps: true,
    startColumn: 2,
    startRow: 14,
    terminalColumns: 100,
  });

  assert.deepEqual(areas[0], {
    target: "project",
    startColumn: 2,
    endColumn: 29,
    startRow: 14,
    endRow: 16,
  });
  assert.equal(selectorControlFromMousePosition({ x: 6, y: 15 }, areas), "project");
  assert.equal(selectorControlFromMousePosition({ x: 34, y: 15 }, areas), "model");
  assert.equal(selectorControlFromMousePosition({ x: 58, y: 15 }, areas), "mode");
  assert.equal(selectorControlFromMousePosition({ x: 78, y: 15 }, areas), "thinking");
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

  assert.equal(selectorControlFromMousePosition({ x: 12, y: 13 }, areas), "project");
  assert.equal(selectorControlFromMousePosition({ x: 12, y: 16 }, areas), "model");
  assert.equal(selectorControlFromMousePosition({ x: 12, y: 19 }, areas), "mode");
  assert.equal(selectorControlFromMousePosition({ x: 12, y: 22 }, areas), undefined);
});
