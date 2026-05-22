import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConnectionDetailModel,
  buildProjectDetailModel,
} from "./workspaceEntityDetails.js";

test("buildProjectDetailModel extracts linked connections and report fields", () => {
  const model = buildProjectDetailModel({
    project: {
      id: "project-1",
      name: "Playground",
      cloud_provider: "azure",
      type: "template",
      status: "ready",
      created_at: "2026-05-20T00:00:00Z",
    } as any,
    connections: [
      {
        id: "connection-1",
        name: "Template sync",
        cloud_provider: "azure",
        project_id: "project-1",
        type: "template",
        last_sync_status: "completed",
      },
    ],
    reportsSummary: {
      project_health: [
        {
          project_id: "project-1",
          coverage_percent: 67,
          critical_issues: 2,
          last_report_at: "2026-05-21T00:00:00Z",
        },
      ],
    },
  });

  assert.ok(model);
  assert.equal(model.title, "Playground");
  assert.deepEqual(model.metrics, [
    { label: "Provider", value: "azure", tone: "brand" },
    { label: "Type", value: "template" },
    { label: "Status", value: "ready", tone: "success" },
    { label: "Connections", value: "1", tone: "brand" },
  ]);
  assert(model.detailRows.some((row) => row.label === "Report coverage" && row.value === "67%"));
  assert(model.detailRows.some((row) => row.label === "Critical issues" && row.value === "2"));
  assert.equal(model.relatedItems[0]?.label, "Template sync");
});

test("buildConnectionDetailModel extracts sync and linked project fields", () => {
  const model = buildConnectionDetailModel({
    connection: {
      id: "connection-1",
      name: "Template sync",
      cloud_provider: "azure",
      type: "template",
      project_id: "project-1",
      template_url: "https://github.com/acme/iac/blob/main/main.json",
      last_sync_status: "failed",
      auto_sync: true,
      last_synced: "2026-05-21T00:00:00Z",
    },
    projects: [{ id: "project-1", name: "Playground" } as any],
  });

  assert.ok(model);
  assert.equal(model.title, "Template sync");
  assert.deepEqual(model.metrics, [
    { label: "Provider", value: "azure", tone: "brand" },
    { label: "Type", value: "template" },
    { label: "Sync", value: "failed", tone: "danger" },
    { label: "Auto", value: "on", tone: "success" },
  ]);
  assert(model.detailRows.some((row) => row.label === "Project" && row.value === "Playground"));
  assert(model.detailRows.some((row) => row.label === "Source" && row.value.includes("github.com")));
});
