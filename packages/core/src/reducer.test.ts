import assert from "node:assert/strict";
import test from "node:test";
import type { VisualizationArtifact, VisualizationChunk } from "@cloudeval/shared";
import { initialChatState, reduceChunk } from "./reducer";

const artifact: VisualizationArtifact = {
  schema: "cloudeval.visualization/v1",
  id: "cost-chart",
  kind: "chart",
  format: "flint",
  title: "Cost",
  renderer: "chartjs",
  data: { values: [{ service: "Compute", cost: 120 }] },
  spec: { type: "bar" },
  config: {},
  fallback: {
    type: "table",
    columns: ["service", "cost"],
    rows: [["Compute", 120]],
  },
};

test("reduceChunk attaches and de-duplicates visualization artifacts", () => {
  const chunk: VisualizationChunk = {
    type: "visualization",
    artifact,
    receivedAt: 10,
  };
  const once = reduceChunk(initialChatState, chunk);
  const twice = reduceChunk(once, { ...chunk, receivedAt: 11 });
  const message = twice.messages.find((entry) => entry.role === "assistant");
  assert.equal(message?.visualizations?.length, 1);
  assert.equal(message?.visualizations?.[0]?.id, "cost-chart");
});
