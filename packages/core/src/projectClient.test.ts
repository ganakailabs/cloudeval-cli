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
  const calls: Array<{ url: string; method: string; body?: string; headers?: Record<string, string> }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: init?.headers as Record<string, string>,
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
    if (String(url).includes("/projects/project-1/iac/pipeline")) {
      return new Response(
        JSON.stringify({
          import: { files_added: 1, files_updated: 0, files_skipped: 0 },
          resolve: { primary_stack_id: "main", linked_file_count: 0 },
          refresh_analysis: { project_reports_autogen: "job-1" },
        }),
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
    assert.equal(
      calls[2].url,
      "https://api.example.test/api/v1/projects/project-1/iac/pipeline?user_id=user-1"
    );
    assert.equal(
      calls[2].body,
      JSON.stringify({
        import_request: { source: "connection", connection_id: "conn-1" },
        resolve: true,
        refresh_analysis: true,
      })
    );
    assert.equal(result.iacPipeline?.resolve?.primary_stack_id, "main");
    assert.match(calls[0].headers?.["Idempotency-Key"] ?? "", /^[0-9a-f-]{36}$/);
    assert.match(calls[1].headers?.["Idempotency-Key"] ?? "", /^[0-9a-f-]{36}$/);
    assert.match(calls[1].body ?? "", /"connection_ids":\["conn-1"\]/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("createQuickProject creates a multi-file IaC workspace project and runs the IaC pipeline", async () => {
  const calls: Array<{ url: string; method: string; body?: BodyInit | null }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body,
    });
    if (String(url).endsWith("/connection/")) {
      return new Response(
        JSON.stringify({ id: "conn-workspace", name: "Workspace Connection" }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    }
    if (String(url).endsWith("/projects/")) {
      return new Response(
        JSON.stringify({ id: "project-workspace", name: "Workspace", connection_ids: ["conn-workspace"] }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    }
    if (String(url).includes("/projects/project-workspace/iac/pipeline")) {
      return new Response(
        JSON.stringify({
          import: { files_added: 3, files_updated: 0, files_skipped: 0 },
          resolve: { primary_stack_id: "main", linked_file_count: 1 },
          refresh_analysis: { project_reports_autogen: "job-1" },
        }),
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
      workspaceFiles: [
        {
          path: "azuredeploy.json",
          blob: new Blob([
            JSON.stringify({
              $schema:
                "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
              contentVersion: "1.0.0.0",
              resources: [
                {
                  type: "Microsoft.Resources/deployments",
                  apiVersion: "2022-09-01",
                  name: "network",
                  properties: {
                    mode: "Incremental",
                    templateLink: { uri: "nested/network.json" },
                  },
                },
              ],
            }),
          ], { type: "application/json" }),
        },
        {
          path: "nested/network.json",
          blob: new Blob([JSON.stringify({ resources: [] })], { type: "application/json" }),
        },
        {
          path: ".cloudeval/config.yaml",
          blob: new Blob(["version: 1\nstacks:\n  - id: main\n    entry: azuredeploy.json\n"], {
            type: "text/yaml",
          }),
        },
      ],
      workspaceEntry: "azuredeploy.json",
      name: "Workspace",
      description: "Nested templates",
      provider: "azure",
    });

    assert.equal(result.project.id, "project-workspace");
    assert.equal(result.connection.id, "conn-workspace");
    assert.equal(result.iacPipeline?.resolve?.primary_stack_id, "main");

    const form = calls[0].body;
    assert.ok(form instanceof FormData);
    assert.equal(form.get("type"), "template");
    assert.equal(form.get("visualization_source_path"), "azuredeploy.json");
    assert.deepEqual(JSON.parse(String(form.get("workspace_file_paths"))), [
      "nested/network.json",
      ".cloudeval/config.yaml",
    ]);

    const pipelineCall = calls.find((call) =>
      call.url.includes("/projects/project-workspace/iac/pipeline")
    );
    assert.ok(pipelineCall);
    assert.match(String(pipelineCall.url), /user_id=user-1/);
    assert.equal(
      pipelineCall.body,
      JSON.stringify({
        import_request: { source: "connection", connection_id: "conn-workspace" },
        resolve: true,
        refresh_analysis: true,
      })
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("createQuickProject falls back to inline workspace upload for older IaC pipeline contracts", async () => {
  const calls: Array<{ url: string; method: string; body?: BodyInit | null }> = [];
  const previousFetch = globalThis.fetch;
  let pipelineAttempts = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body,
    });
    if (String(url).endsWith("/connection/")) {
      return new Response(
        JSON.stringify({ id: "conn-workspace", name: "Workspace Connection" }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    }
    if (String(url).endsWith("/projects/")) {
      return new Response(
        JSON.stringify({ id: "project-workspace", name: "Workspace", connection_ids: ["conn-workspace"] }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    }
    if (String(url).includes("/projects/project-workspace/iac/pipeline")) {
      pipelineAttempts += 1;
      if (pipelineAttempts === 1) {
        return new Response(
          JSON.stringify({
            detail: [
              {
                loc: ["body", "import_request", "source"],
                msg: "Input should be 'upload' or 'github'",
              },
            ],
          }),
          { status: 422, statusText: "Unprocessable Entity", headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          import: { files_added: 2 },
          resolve: { primary_stack_id: "main", linked_file_count: 1 },
        }),
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
      workspaceFiles: [
        {
          path: "azuredeploy.json",
          blob: new Blob([JSON.stringify({ resources: [] })], {
            type: "application/json",
          }),
        },
        {
          path: "nested/storage.json",
          blob: new Blob([JSON.stringify({ resources: [] })], {
            type: "application/json",
          }),
        },
      ],
      workspaceEntry: "azuredeploy.json",
      name: "Workspace",
      description: "Nested templates",
      provider: "azure",
    });

    assert.equal(result.iacPipeline?.resolve?.primary_stack_id, "main");
    assert.equal(pipelineAttempts, 2);

    const pipelineCalls = calls.filter((call) =>
      call.url.includes("/projects/project-workspace/iac/pipeline")
    );
    assert.equal(
      pipelineCalls[0].body,
      JSON.stringify({
        import_request: { source: "connection", connection_id: "conn-workspace" },
        resolve: true,
        refresh_analysis: true,
      })
    );
    assert.deepEqual(JSON.parse(String(pipelineCalls[1].body)), {
      import_request: {
        source: "upload",
        files: [
          { path: "azuredeploy.json", content: JSON.stringify({ resources: [] }) },
          { path: "nested/storage.json", content: JSON.stringify({ resources: [] }) },
        ],
      },
      resolve: true,
      refresh_analysis: true,
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("createQuickProject creates a Cloud sync project from Azure credentials", async () => {
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
        JSON.stringify({ id: "conn-sync", name: "Cloud Sync", type: "sync" }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    }
    if (String(url).endsWith("/projects/")) {
      return new Response(
        JSON.stringify({ id: "project-sync", name: "Cloud Sync", type: "sync", connection_ids: ["conn-sync"] }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await createQuickProject({
      baseUrl: "https://api.example.test/api/v1",
      authToken: "token",
      userId: "user-1",
      cloudSync: {
        tenantId: "tenant-1",
        clientId: "client-1",
        clientSecret: "secret-1",
        subscriptionId: "sub-1",
        resourceGroups: ["rg-app", "rg-network"],
      },
      name: "Cloud Sync",
      description: "Live Azure project",
      provider: "azure",
    });

    assert.equal(result.project.id, "project-sync");
    assert.equal(result.connection.id, "conn-sync");

    const connectionPayload = JSON.parse(calls[0].body ?? "{}");
    assert.equal(connectionPayload.type, "sync");
    assert.equal(connectionPayload.subscription_id, "sub-1");
    assert.deepEqual(connectionPayload.target_resource_groups, ["rg-app", "rg-network"]);
    assert.deepEqual(connectionPayload.credentials, {
      tenant_id: "tenant-1",
      client_id: "client-1",
      client_secret: "secret-1",
      subscription_id: "sub-1",
    });

    const projectPayload = JSON.parse(calls[1].body ?? "{}");
    assert.equal(projectPayload.type, "sync");
    assert.deepEqual(projectPayload.connection_ids, ["conn-sync"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
