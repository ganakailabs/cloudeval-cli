import assert from "node:assert/strict";
import test from "node:test";
import {
  parseGraphInsightContentBlocks,
  renderTerminalMermaid,
  resolveGraphDiagramMode,
} from "./graphInsightDiagram.js";

const flowchart = [
  "flowchart LR",
  "  VM1[VM 1] --> Pool[Backend Pool]",
  "  Pool --> ILB[Internal Load Balancer]",
].join("\n");

test("parseGraphInsightContentBlocks promotes mermaid fences to diagram blocks", () => {
  const blocks = parseGraphInsightContentBlocks(
    [
      "## Topology",
      "```mermaid",
      flowchart,
      "```",
      "```json",
      "{\"ok\":true}",
      "```",
    ].join("\n")
  );

  assert.deepEqual(
    blocks.map((block) => block.type),
    ["text", "mermaid", "code"]
  );
  assert.equal(blocks[1]?.content, flowchart);
  assert.equal(blocks[2]?.type, "code");
  if (blocks[2]?.type === "code") {
    assert.equal(blocks[2].language, "json");
  }
});

test("resolveGraphDiagramMode gates auto rendering to real terminals", () => {
  assert.equal(resolveGraphDiagramMode({ requested: "off", isTTY: true, columns: 120 }), "off");
  assert.equal(resolveGraphDiagramMode({ requested: "ascii", isTTY: true, columns: 120 }), "ascii");
  assert.equal(resolveGraphDiagramMode({ requested: "unicode", isTTY: true, columns: 120 }), "unicode");
  assert.equal(resolveGraphDiagramMode({ requested: "auto", isTTY: false, columns: 120 }), "off");
  assert.equal(resolveGraphDiagramMode({ requested: "auto", isTTY: true, columns: 30 }), "off");
  assert.equal(resolveGraphDiagramMode({ requested: "auto", isTTY: true, columns: 120 }), "unicode");
});

test("resolveGraphDiagramMode rejects unsupported modes", () => {
  assert.throws(
    () => resolveGraphDiagramMode({ requested: "image", isTTY: true, columns: 120 }),
    /Graph diagram mode must be one of/
  );
});

test("renderTerminalMermaid returns unicode output from the renderer", () => {
  const rendered = renderTerminalMermaid(flowchart, {
    mode: "unicode",
    renderer: () => ({ plain: ["VM 1 ──► Backend Pool"], width: 24 }),
  });

  assert.equal(rendered.status, "rendered");
  assert.equal(rendered.content, "VM 1 ──► Backend Pool");
});

test("renderTerminalMermaid strips box-drawing glyphs in ascii mode", () => {
  const rendered = renderTerminalMermaid(flowchart, {
    mode: "ascii",
    renderer: () => ({
      plain: ["┌────┐", "│ VM │──► Pool", "└────┘"],
      width: 12,
    }),
  });

  assert.equal(rendered.status, "rendered");
  assert.equal(rendered.content, "+----+\n| VM |--> Pool\n+----+");
  assert.doesNotMatch(rendered.content, /[^\x09\x0a\x0d\x20-\x7e]/);
});

test("renderTerminalMermaid falls back to mermaid source when rendering fails", () => {
  const rendered = renderTerminalMermaid("architecture-beta\n  group vnet", {
    mode: "unicode",
    renderer: () => {
      throw new Error("Unsupported diagram");
    },
  });

  assert.equal(rendered.status, "fallback");
  assert.match(rendered.content, /```mermaid\narchitecture-beta/);
  assert.match(rendered.reason ?? "", /Unsupported diagram/);
});

test("renderTerminalMermaid falls back when rendered art is wider than the terminal", () => {
  const rendered = renderTerminalMermaid(flowchart, {
    mode: "unicode",
    columns: 10,
    renderer: () => ({ plain: ["VM 1 ──► Backend Pool"], width: 24 }),
  });

  assert.equal(rendered.status, "fallback");
  assert.match(rendered.reason ?? "", /needs 24 columns/);
  assert.match(rendered.content, /```mermaid\nflowchart LR/);
});

test("renderTerminalMermaid renders real flowcharts with grok-mermaid", () => {
  const rendered = renderTerminalMermaid(flowchart, {
    mode: "ascii",
    columns: 120,
  });

  assert.equal(rendered.status, "rendered");
  assert.match(rendered.content, /VM 1/);
  assert.match(rendered.content, /Backend Pool/);
  assert.doesNotMatch(rendered.content, /[^\x09\x0a\x0d\x20-\x7e]/);
});

test("renderTerminalMermaid falls back for unsupported architecture diagrams", () => {
  const rendered = renderTerminalMermaid("architecture-beta\n  group vnet(cloud)[VNet]", {
    mode: "unicode",
  });

  assert.equal(rendered.status, "fallback");
  assert.match(rendered.content, /```mermaid\narchitecture-beta/);
});
