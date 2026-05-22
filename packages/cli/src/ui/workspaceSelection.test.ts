import assert from "node:assert/strict";
import test from "node:test";
import {
  nextWorkspaceSelectionIndex,
  selectableWorkspaceTab,
} from "./workspaceSelection";

test("selectableWorkspaceTab limits row selection to project and connection lists", () => {
  assert.equal(selectableWorkspaceTab("projects"), true);
  assert.equal(selectableWorkspaceTab("connections"), true);
  assert.equal(selectableWorkspaceTab("reports"), false);
  assert.equal(selectableWorkspaceTab("billing"), false);
});

test("nextWorkspaceSelectionIndex clamps project and connection navigation", () => {
  assert.equal(nextWorkspaceSelectionIndex({ currentIndex: 0, itemCount: 3, direction: 1 }), 1);
  assert.equal(nextWorkspaceSelectionIndex({ currentIndex: 2, itemCount: 3, direction: 1 }), 2);
  assert.equal(nextWorkspaceSelectionIndex({ currentIndex: 0, itemCount: 3, direction: -1 }), 0);
  assert.equal(nextWorkspaceSelectionIndex({ currentIndex: 5, itemCount: 3, direction: -1 }), 1);
  assert.equal(nextWorkspaceSelectionIndex({ currentIndex: 0, itemCount: 0, direction: 1 }), 0);
});
