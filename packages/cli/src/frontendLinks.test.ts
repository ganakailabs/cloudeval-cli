import assert from "node:assert/strict";
import test from "node:test";
import { buildFrontendUrl, resolveFrontendBaseUrl } from "./frontendLinks";

test("resolveFrontendBaseUrl uses explicit frontend url first", () => {
  assert.equal(
    resolveFrontendBaseUrl({
      frontendUrl: "https://app.example.test",
      apiBaseUrl: "http://localhost:8000/api/v1",
    }),
    "https://app.example.test",
  );
});

test("resolveFrontendBaseUrl maps local API to local frontend", () => {
  assert.equal(
    resolveFrontendBaseUrl({ apiBaseUrl: "http://localhost:8000/api/v1" }),
    "http://localhost:3000",
  );
});

test("resolveFrontendBaseUrl defaults to the public frontend host", () => {
  assert.equal(
    resolveFrontendBaseUrl({ apiBaseUrl: "https://cloudeval.ai/api/proxy/v1" }),
    "https://cloudeval.ai",
  );
});

test("buildFrontendUrl builds project preview/code deep links", () => {
  assert.equal(
    buildFrontendUrl({
      baseUrl: "https://www.cloudeval.ai",
      target: "project",
      projectId: "project-1",
      view: "both",
      layout: "dependency",
      node: ["node-a", "node-b"],
      resource: "node-a",
      tab: "problems",
      file: "main.bicep",
      workspaceFocus: true,
      presentation: true,
    }),
    "https://www.cloudeval.ai/app/projects/project-1?view=both&layout=dependency&node=node-a%2Cnode-b&resource=node-a&tab=problems&file=main.bicep&workspaceFocus=true&mode=presentation",
  );
});

test("buildFrontendUrl builds quick project dialog link from generic template URL", () => {
  assert.equal(
    buildFrontendUrl({
      baseUrl: "https://www.cloudeval.ai",
      target: "projects",
      quick: true,
      templateUrl: "https://example.com/template.json",
      name: "Demo Project",
      provider: "azure",
      autoSubmit: true,
    }),
    "https://www.cloudeval.ai/app/projects?dialog=quick&template_url=https%3A%2F%2Fexample.com%2Ftemplate.json&name=Demo+Project&provider=azure&auto_submit=true",
  );
});

test("buildFrontendUrl builds billing tab links", () => {
  assert.equal(
    buildFrontendUrl({
      baseUrl: "https://www.cloudeval.ai",
      target: "billing",
      tab: "usage",
    }),
    "https://www.cloudeval.ai/app/subscription?tab=usage",
  );
});

test("buildFrontendUrl builds report PDF links with explicit verbosity", () => {
  assert.equal(
    buildFrontendUrl({
      baseUrl: "https://www.cloudeval.ai",
      target: "reports",
      projectId: "project-1",
      tab: "cost",
      downloadPdf: true,
      pdfVerbosity: "evidence",
    }),
    "https://www.cloudeval.ai/app/reports/project-1?tab=cost&downloadPdf=1&pdfVerbosity=evidence",
  );
});

test("buildFrontendUrl builds report Markdown and JSON download links", () => {
  assert.equal(
    buildFrontendUrl({
      baseUrl: "https://www.cloudeval.ai",
      target: "reports",
      projectId: "project-1",
      tab: "overview",
      downloadReport: "markdown",
      reportVerbosity: "brief",
    }),
    "https://www.cloudeval.ai/app/reports/project-1?tab=overview&downloadReport=markdown&reportVerbosity=brief",
  );

  assert.equal(
    buildFrontendUrl({
      baseUrl: "https://www.cloudeval.ai",
      target: "reports",
      projectId: "project-1",
      tab: "architecture",
      downloadReport: "json",
      reportVerbosity: "evidence",
    }),
    "https://www.cloudeval.ai/app/reports/project-1?tab=architecture&downloadReport=json&reportVerbosity=evidence",
  );
});
