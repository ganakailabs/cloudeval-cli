import assert from "node:assert/strict";
import test from "node:test";
import {
  extractVisualizationArtifactsFromMarkdown,
  parseVisualizationArtifact,
  mergeVisualizationArtifactsIntoMarkdown,
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

test("final markdown preserves authoritative artifacts omitted from streamed prose", () => {
  const result = mergeVisualizationArtifactsIntoMarkdown("Cost summary.", [validChart]);
  assert.match(result, /^Cost summary\./);
  assert.deepEqual(JSON.parse(JSON.stringify(extractVisualizationArtifactsFromMarkdown(result))), [validChart]);
  assert.equal(mergeVisualizationArtifactsIntoMarkdown(result, [validChart]), result);
});

test("final markdown replaces malformed, altered, and duplicate Flint echoes", () => {
  for (const echo of ["{broken", JSON.stringify({ ...validChart, title: "Invented title" })]) {
    const input = `Summary.\n\n\`\`\`flint\n${echo}\n\`\`\`\n\nSources.\n\n\`\`\`flint\n${echo}\n\`\`\``;
    const result = mergeVisualizationArtifactsIntoMarkdown(input, [validChart, validChart]);
    assert.deepEqual(JSON.parse(JSON.stringify(extractVisualizationArtifactsFromMarkdown(result))), [validChart]);
    assert.equal((result.match(/```flint/g) ?? []).length, 1);
    assert.match(result, /Sources\./);
  }
  const truncated = mergeVisualizationArtifactsIntoMarkdown("Summary.\n```flint\n{broken", [validChart]);
  assert.deepEqual(JSON.parse(JSON.stringify(extractVisualizationArtifactsFromMarkdown(truncated))), [validChart]);
});

test("final markdown leaves ordinary responses and invalid side events unchanged", () => {
  const content = "Summary.\n```json\n{}\n```";
  assert.equal(mergeVisualizationArtifactsIntoMarkdown(content, []), content);
  assert.equal(mergeVisualizationArtifactsIntoMarkdown(content, [{ ...validChart, schema: "bad" }]), content);
});

test("final markdown repairs bare opening fences and escapes delimiter text losslessly", () => {
  const artifact = { ...validChart, title: "Use ``` code" };
  for (const input of ["Summary.", "Summary.\n```flint", "Summary.\n```flint\n{bad"]) {
    const result = mergeVisualizationArtifactsIntoMarkdown(input, [artifact]);
    assert.deepEqual(JSON.parse(JSON.stringify(extractVisualizationArtifactsFromMarkdown(result))), [artifact]);
    assert.equal(mergeVisualizationArtifactsIntoMarkdown(result, [artifact]), result);
  }
});

test("final markdown retains caveats after indented fences and is stable with multiple events", () => {
  for (let indent = 0; indent <= 3; indent += 1) {
    const spaces = " ".repeat(indent);
    const input = `Summary.\n${spaces}\`\`\`flint\n${JSON.stringify(validChart)}\n${spaces}\`\`\`\n\nImportant sources and caveats.`;
    const result = mergeVisualizationArtifactsIntoMarkdown(input, [validChart]);
    assert.match(result, /Important sources and caveats\.$/);
    assert.equal(extractVisualizationArtifactsFromMarkdown(result).length, 1);
  }
  const events = [validChart, { ...validChart, id: "second-chart" }];
  const result = mergeVisualizationArtifactsIntoMarkdown("Summary.", events);
  assert.equal(mergeVisualizationArtifactsIntoMarkdown(result, events), result);
  const withProse = `${result}\n\nImportant sources and caveats.`;
  assert.equal(mergeVisualizationArtifactsIntoMarkdown(withProse, events), withProse);
});

test("final markdown preserves Mermaid and legacy chart events without duplicate fences", () => {
  for (const source of [
    "```mermaid\nflowchart LR\n  api[API] --> db[(Database)]\n```",
    '```chart\n{"type":"bar","data":{"labels":["Compute"],"datasets":[{"label":"Cost","data":[120]}]}}\n```',
  ]) {
    const artifacts = extractVisualizationArtifactsFromMarkdown(source).map((artifact) => ({
      ...artifact, id: "authoritative-event", title: "Exact title", warnings: ["Estimate"], evidence_refs: ["source-1"],
    }));
    const result = mergeVisualizationArtifactsIntoMarkdown("Summary.", artifacts);
    assert.deepEqual(JSON.parse(JSON.stringify(extractVisualizationArtifactsFromMarkdown(result))), JSON.parse(JSON.stringify(artifacts)));
    assert.equal(mergeVisualizationArtifactsIntoMarkdown(result, artifacts), result);
  }
});

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
