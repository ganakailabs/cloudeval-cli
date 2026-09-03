import assert from "node:assert/strict";
import test from "node:test";
import {
  extractVisualizationArtifactsFromMarkdown,
  parseVisualizationArtifact,
} from "./visualizationArtifacts";

const validChart = {
  schema: "cloudeval.visualization/v1",
  id: "monthly-cost-by-service",
  kind: "chart",
  format: "flint",
  title: "Monthly cost by service",
  renderer: "chartjs",
  data: {
    values: [
      { service: "Compute", cost: 120 },
      { service: "Storage", cost: 40 },
    ],
  },
  spec: {
    type: "bar",
    x: { field: "service", type: "nominal" },
    y: { field: "cost", type: "quantitative" },
  },
  config: { type: "bar", data: { labels: ["Compute", "Storage"] } },
  fallback: {
    type: "table",
    columns: ["service", "cost"],
    rows: [["Compute", 120], ["Storage", 40]],
  },
};

test("parseVisualizationArtifact accepts the v1 chart contract", () => {
  const parsed = parseVisualizationArtifact(validChart);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.artifact.schema, "cloudeval.visualization/v1");
    assert.equal(parsed.artifact.kind, "chart");
    assert.equal(parsed.artifact.data.values.length, 2);
  }
});

test("parseVisualizationArtifact rejects unsafe and unbounded artifacts", () => {
  assert.equal(
    parseVisualizationArtifact({ ...validChart, id: "bad\u001b[31m-id" }).ok,
    false,
  );
  assert.equal(
    parseVisualizationArtifact({
      ...validChart,
      data: { values: Array.from({ length: 201 }, (_, cost) => ({ cost })) },
    }).ok,
    false,
  );
  assert.equal(
    parseVisualizationArtifact({ ...validChart, schema: "future/v99" }).ok,
    false,
  );
});

test("extractVisualizationArtifactsFromMarkdown parses complete Flint fences", () => {
  const markdown = `Cost summary.\n\n\`\`\`flint\n${JSON.stringify(validChart)}\n\`\`\``;
  const artifacts = extractVisualizationArtifactsFromMarkdown(markdown);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.id, "monthly-cost-by-service");
});

test("extractVisualizationArtifactsFromMarkdown waits for a closing fence", () => {
  const markdown = `\`\`\`flint\n${JSON.stringify(validChart)}`;
  assert.deepEqual(extractVisualizationArtifactsFromMarkdown(markdown), []);
});

test("extractVisualizationArtifactsFromMarkdown wraps legacy chart and Mermaid fences", () => {
  const chart = extractVisualizationArtifactsFromMarkdown(
    '```chart\n{"type":"bar","data":{"labels":["Compute"],"datasets":[{"label":"Cost","data":[120]}]}}\n```',
  );
  assert.equal(chart[0]?.kind, "chart");
  assert.equal(chart[0]?.format, "chartjs");
  assert.deepEqual(chart[0]?.fallback.rows, [["Compute", 120]]);

  const mermaid = extractVisualizationArtifactsFromMarkdown(
    "```mermaid\nflowchart LR\n  api[API] --> db[(Database)]\n```",
  );
  assert.equal(mermaid[0]?.kind, "diagram");
  assert.equal(mermaid[0]?.format, "mermaid");
  assert.deepEqual(mermaid[0]?.fallback.edges, [["API", "Database"]]);
});

test("extractVisualizationArtifactsFromMarkdown de-duplicates artifact ids", () => {
  const fence = `\`\`\`flint\n${JSON.stringify(validChart)}\n\`\`\``;
  assert.equal(extractVisualizationArtifactsFromMarkdown(`${fence}\n${fence}`).length, 1);
});
