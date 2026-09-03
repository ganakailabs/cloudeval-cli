import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChartVisualizationArtifact,
  VisualizationArtifact,
} from "@cloudeval/shared";
import { renderTerminalVisualization } from "./terminalVisualizations";

const chart = (
  type: string,
  values: Array<Record<string, string | number | boolean | null>>,
): ChartVisualizationArtifact => ({
  schema: "cloudeval.visualization/v1",
  id: `${type}-chart`,
  kind: "chart",
  format: "flint",
  title: `${type} chart`,
  renderer: "chartjs",
  data: { values },
  spec: {
    type,
    x: { field: "label", type: "nominal" },
    y: { field: "value", type: "quantitative" },
  },
  config: {},
  fallback: {
    type: "table",
    columns: ["label", "value"],
    rows: values.map((row) => [row.label ?? null, row.value ?? null]),
  },
});

test("renderTerminalVisualization renders trends without ANSI control sequences", () => {
  const rendered = renderTerminalVisualization(
    chart("line", [
      { label: "Jan", value: 10 },
      { label: "Feb", value: 25 },
      { label: "Mar", value: 18 },
    ]),
    80,
  );
  assert.equal(rendered.mode, "line");
  assert.match(rendered.lines.join("\n"), /10|18|25/);
  assert.doesNotMatch(rendered.lines.join("\n"), /\u001b|\u009b/);
});

test("renderTerminalVisualization renders bars and bounds narrow output", () => {
  const rendered = renderTerminalVisualization(
    chart("bar", [
      { label: "Compute with a very long category", value: 120 },
      { label: "Storage", value: 40 },
    ]),
    32,
  );
  assert.equal(rendered.mode, "bar");
  assert.match(rendered.lines.join("\n"), /█/);
  assert.ok(rendered.lines.every((line) => [...line].length <= 28));
});

test("renderTerminalVisualization renders scatter and heatmap families", () => {
  const scatter = renderTerminalVisualization(
    {
      ...chart("scatter", [
        { label: "a", value: 2, x: 1, y: 2 },
        { label: "b", value: 4, x: 3, y: 4 },
      ]),
      spec: {
        type: "scatter",
        x: { field: "x", type: "quantitative" },
        y: { field: "y", type: "quantitative" },
      },
    },
    40,
  );
  assert.equal(scatter.mode, "scatter");
  assert.match(scatter.lines.join(""), /•/);

  const heatmap = renderTerminalVisualization(
    {
      ...chart("heatmap", [
        { label: "Mon", value: 1, column: "API" },
        { label: "Mon", value: 8, column: "DB" },
        { label: "Tue", value: 4, column: "API" },
        { label: "Tue", value: 10, column: "DB" },
      ]),
      spec: {
        type: "heatmap",
        x: { field: "column", type: "nominal" },
        y: { field: "label", type: "nominal" },
        color: { field: "value", type: "quantitative" },
      },
    },
    40,
  );
  assert.equal(heatmap.mode, "heatmap");
  assert.match(heatmap.lines.join(""), /[░▒▓█]/);
});

test("renderTerminalVisualization converts Mermaid edges to Unicode", () => {
  const artifact: VisualizationArtifact = {
    schema: "cloudeval.visualization/v1",
    id: "topology",
    kind: "diagram",
    format: "mermaid",
    title: "Topology",
    renderer: "mermaid",
    source: "flowchart LR\n  API -->|queries| DB",
    fallback: {
      type: "edge-list",
      edges: [["API", "DB", "queries"]],
      source: "flowchart LR\n  API -->|queries| DB",
    },
  };
  const rendered = renderTerminalVisualization(artifact, 80);
  assert.equal(rendered.mode, "edge-list");
  assert.deepEqual(rendered.lines, ["API ──queries──▶ DB"]);
});

test("renderTerminalVisualization uses a table for unsupported chart types", () => {
  const rendered = renderTerminalVisualization(
    chart("sankey", [{ label: "API", value: 2 }]),
    40,
  );
  assert.equal(rendered.mode, "table");
  assert.match(rendered.lines.join("\n"), /label/);
  assert.match(rendered.lines.join("\n"), /API/);
});
