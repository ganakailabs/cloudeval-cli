import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQuickProjectPayload,
  parseTemplateUrl,
  createQuickProject,
} from "./projectClient";

test("parseTemplateUrl normalizes GitHub blob URLs and infers metadata", () => {
  const parsed = parseTemplateUrl(
    "https://github.com/acme/cloud/tree/main/templates/webapp"
  );

  assert.deepEqual(parsed, {
    normalizedUrl:
      "https://raw.githubusercontent.com/acme/cloud/main/templates/webapp/azuredeploy.json",
    githubUrl: "https://github.com/acme/cloud/tree/main/templates/webapp",
    cloudProvider: "azure",
    suggestedName: "webapp",
    suggestedDescription: "Template from acme/cloud",
    owner: "acme",
    repo: "cloud",
    branch: "main",
    filePath: "templates/webapp/azuredeploy.json",
  });
});

test("buildQuickProjectPayload accepts generic template URLs without GitHub-specific flag", () => {
  assert.deepEqual(
    buildQuickProjectPayload({
      userId: "user-1",
      templateUrl: "https://example.com/template.json",
      name: "Example",
      description: "Demo",
      provider: "azure",
      parametersUrl: "https://example.com/parameters.json",
    }),
    {
      connection: {
        user_id: "user-1",
        name: "Example Connection",
        cloud_provider: "azure",
        description: "Demo",
        type: "template",
        template_url: "https://example.com/template.json",
        parameters_file_url: "https://example.com/parameters.json",
        auto_sync: true,
      },
      project: {
        user_id: "user-1",
        name: "Example",
        description: "Demo",
        cloud_provider: "azure",
        connection_ids: [],
        type: "template",
        report_config: {
          auto_generate_reports: true,
          include_cost_report: true,
          include_cost_forecast: true,
          region: "eastus",
          currency: "USD",
        },
      },
      normalizedTemplateUrl: "https://example.com/template.json",
      inferred: null,
    }
  );
});

test("createQuickProject creates connection then project", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (String(url).endsWith("/connection/")) {
      return new Response(
        JSON.stringify({ id: "conn-1", name: "Example Connection" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (String(url).endsWith("/projects/")) {
      return new Response(
        JSON.stringify({ id: "project-1", name: "Example", connection_ids: ["conn-1"] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await createQuickProject({
      baseUrl: "https://api.example.test/api/v1",
      authToken: "token",
      userId: "user-1",
      templateUrl: "https://example.com/template.json",
      name: "Example",
      description: "Demo",
      provider: "azure",
    });

    assert.equal(result.connection.id, "conn-1");
    assert.equal(result.project.id, "project-1");
    assert.equal(calls[0].url, "https://api.example.test/api/v1/connection/");
    assert.equal(calls[1].url, "https://api.example.test/api/v1/projects/");
    assert.match(calls[1].body ?? "", /"connection_ids":\["conn-1"\]/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
