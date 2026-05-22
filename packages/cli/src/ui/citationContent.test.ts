import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCitationReferences,
  buildReferencesSection,
  getCitationSourceOrder,
  toCitationExportContent,
  toDisplayCitationContent,
} from "./citationContent";

test("toDisplayCitationContent numbers raw source tags in first appearance order", () => {
  const content =
    "Architecture risk summary.[S_tool_architecture_dashboard_0] Cost follows.[S_tool_cost_report_1]";

  assert.equal(
    toDisplayCitationContent(content),
    "Architecture risk summary.[1] Cost follows.[2]"
  );
  assert.deepEqual(getCitationSourceOrder(content), [
    "tool_architecture_dashboard_0",
    "tool_cost_report_1",
  ]);
});

test("toDisplayCitationContent caps repeated citations from the same source", () => {
  const content =
    "A.[S_tool_graph_schema_0] B.[S_tool_graph_schema_0] C.[S_tool_graph_schema_0] D.[S_tool_graph_schema_0]";

  assert.equal(toDisplayCitationContent(content), "A.[1] B.[1] C.[1] D.");
});

test("buildCitationReferences prefers citation metadata over tool metadata", () => {
  const content =
    "Azure requires strong controls.[S_tool_security_docs_0] Logging helps audits.[S_tool_logging_docs_1]";
  const references = buildCitationReferences({
    content,
    toolsUsed: [
      {
        source_id: "tool_security_docs_0",
        title: "Raw search title",
      },
      {
        source_id: "tool_logging_docs_1",
        tool_friendly_name: "Web search",
      },
    ],
    citations: [
      {
        source_id: "tool_security_docs_0",
        title: "Azure security baseline",
        url: "https://example.com/security",
      },
      {
        source_id: "tool_logging_docs_1",
        title: "Azure audit logging guide",
        url: "https://example.com/logging",
      },
    ],
  });

  assert.deepEqual(references, [
    {
      number: 1,
      sourceId: "tool_security_docs_0",
      label: "Azure security baseline",
      url: "https://example.com/security",
    },
    {
      number: 2,
      sourceId: "tool_logging_docs_1",
      label: "Azure audit logging guide",
      url: "https://example.com/logging",
    },
  ]);
  assert.equal(
    buildReferencesSection(references),
    [
      "---",
      "## References",
      "- [1] Azure security baseline - https://example.com/security",
      "- [2] Azure audit logging guide - https://example.com/logging",
    ].join("\n")
  );
});

test("toCitationExportContent appends references for copy and download", () => {
  const content = "Architecture risk summary.[S_tool_architecture_dashboard_0]";

  assert.equal(
    toCitationExportContent({
      content,
      toolsUsed: [
        {
          source_id: "tool_architecture_dashboard_0",
          title: "Architecture dashboard",
        },
      ],
    }),
    [
      "Architecture risk summary.[1]",
      "",
      "---",
      "## References",
      "- [1] Architecture dashboard",
    ].join("\n")
  );
});
