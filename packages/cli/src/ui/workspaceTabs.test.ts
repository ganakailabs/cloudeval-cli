import test from "node:test";
import assert from "node:assert/strict";
import {
  getWorkspaceTabHitAreas,
  nextWorkspaceTab,
  normalizeWorkspaceTab,
  workspaceTabFromPromptChange,
  workspaceTabFromColumn,
  workspaceTabFromShortcut,
  workspaceTabs,
} from "./workspaceTabs.js";

test("normalizes workspace tab names", () => {
  assert.equal(normalizeWorkspaceTab("billing"), "billing");
  assert.equal(normalizeWorkspaceTab("Reports"), "reports");
  assert.equal(normalizeWorkspaceTab("missing"), "chat");
  assert.equal(normalizeWorkspaceTab(undefined), "chat");
});

test("cycles workspace tabs in both directions", () => {
  assert.equal(nextWorkspaceTab("chat"), "overview");
  assert.equal(nextWorkspaceTab("chat", -1), "options");
  assert.equal(nextWorkspaceTab("options"), "chat");
});

test("maps numeric shortcuts to tabs", () => {
  assert.equal(workspaceTabFromShortcut("1"), "chat");
  assert.equal(workspaceTabFromShortcut(String(workspaceTabs.length)), "options");
  assert.equal(workspaceTabFromShortcut("0"), undefined);
  assert.equal(workspaceTabFromShortcut("8"), undefined);
});

test("recognizes tab shortcuts before prompt input stores the digit", () => {
  assert.equal(workspaceTabFromPromptChange("", "2"), "overview");
  assert.equal(workspaceTabFromPromptChange("", "7"), "options");
  assert.equal(workspaceTabFromPromptChange("ask", "ask2"), undefined);
  assert.equal(workspaceTabFromPromptChange("", "22"), undefined);
});

test("builds clickable terminal hit areas for visible tab buttons", () => {
  const areas = getWorkspaceTabHitAreas({ startColumn: 3, gap: 1 });

  assert.deepEqual(areas[0], {
    tab: "chat",
    label: "1 Chat",
    startColumn: 3,
    endColumn: 14,
  });
  assert.equal(workspaceTabFromColumn(3, areas), "chat");
  assert.equal(workspaceTabFromColumn(14, areas), "chat");
  assert.equal(workspaceTabFromColumn(15, areas), undefined);
  assert.equal(workspaceTabFromColumn(16, areas), "overview");
});
