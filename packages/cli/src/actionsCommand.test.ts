import assert from "node:assert/strict";
import test from "node:test";

import { renderActionsListText, splitCsv } from "./actionsCommand.js";

test("splitCsv parses comma-separated filters", () => {
  assert.deepEqual(splitCsv("architecture,cost"), ["architecture", "cost"]);
  assert.deepEqual(splitCsv(" critical , high "), ["critical", "high"]);
  assert.equal(splitCsv(undefined), undefined);
  assert.equal(splitCsv("   "), undefined);
});

test("renderActionsListText renders table rows for action center items", () => {
  const text = renderActionsListText({
    items: [
      {
        id: "arch:p1:rule-1",
        type: "architecture",
        severity: "critical",
        project_name: "Playground",
        title: "Public storage",
        resource_name: "stg-demo",
        monthly_savings: null,
      },
      {
        id: "cost:p1:rec-1",
        type: "cost",
        severity: "medium",
        project_name: "Playground",
        title: "Resize VM",
        resource_id: "vm-1",
        monthly_savings: 42.5,
      },
    ],
  });

  assert.match(text, /arch:p1:r/);
  assert.match(text, /architecture/);
  assert.match(text, /critical/);
  assert.match(text, /Playground/);
  assert.match(text, /Public storage/);
  assert.match(text, /cost:p1:r/);
  assert.match(text, /42\.5/);
});

test("renderActionsListText handles empty inventory", () => {
  const text = renderActionsListText({ items: [] });
  assert.match(text, /No action center items found/);
});
