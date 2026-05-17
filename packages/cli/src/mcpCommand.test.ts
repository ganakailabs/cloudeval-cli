import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const MCP_RESPONSE_TIMEOUT_MS = 15_000;
const MCP_CLOSE_TIMEOUT_MS = 10_000;

const user = {
  id: "user-1",
  email: "agent@example.test",
  full_name: "Agent User",
  preferences: { onboarding: { completedAt: "2026-05-04T00:00:00.000Z" } },
};

const project = {
  id: "project-main",
  name: "Playground",
  user_id: user.id,
  cloud_provider: "azure",
  type: "template",
};

const templateFixture = {
  $schema:
    "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  resources: [
    {
      type: "Microsoft.Storage/storageAccounts",
      apiVersion: "2022-09-01",
      name: "sttest001",
      location: "eastus",
      sku: { name: "Standard_LRS" },
      kind: "StorageV2",
    },
  ],
};

const parameterFileFixture = {
  parameters: {
    location: { value: "eastus2" },
  },
};

const agentProfile = {
  id: "cost",
  display_name: "Cost",
  description: "Reviews project cost drivers.",
  personality: "Commercially pragmatic.",
  accent_key: "emerald",
  icon_key: "wallet",
  default_mode: "agent",
  starter_prompt: "Review live sync cost risk.",
  starter_prompts: {
    template: "Review ARM/Bicep template cost risk.",
    sync: "Review live sync cost risk.",
  },
  required_capabilities: ["projects:read", "reports:read", "billing:read", "ask:run"],
  default_settings: {
    mode: "agent",
    response_length: "Detailed",
    technicality: "Expert",
    reasoning_effort: "medium",
  },
};

const collectBody = async (req: http.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const json = (res: http.ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};

const startBackend = async (
  options: {
    agentProfilesStatus?: number;
  } = {},
) => {
  const requests: Array<{
    path: string;
    query: URLSearchParams;
    authorization?: string;
    body: string;
  }> = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = await collectBody(req);
    requests.push({
      path: url.pathname,
      query: url.searchParams,
      authorization: req.headers.authorization,
      body,
    });

    if (url.pathname === "/api/v1/auth/me") {
      return json(res, user);
    }
    if (url.pathname === "/api/v1/agent-profiles") {
      if (options.agentProfilesStatus) {
        return json(
          res,
          {
            error: "Authentication required for this endpoint",
            code: "AUTH_REQUIRED_PUBLIC",
            requiresAuth: true,
          },
          options.agentProfilesStatus,
        );
      }
      return json(res, { profiles: [agentProfile] });
    }
    if (url.pathname.startsWith("/api/v1/agent-profiles/")) {
      if (options.agentProfilesStatus) {
        return json(
          res,
          {
            error: "Authentication required for this endpoint",
            code: "AUTH_REQUIRED_PUBLIC",
            requiresAuth: true,
          },
          options.agentProfilesStatus,
        );
      }
      if (url.pathname === "/api/v1/agent-profiles/cost") {
        return json(res, { profile: agentProfile });
      }
    }
    if (url.pathname === `/api/v1/projects/user/${user.id}`) {
      return json(res, [project]);
    }
    if (url.pathname === "/api/v1/chat/stream" && req.method === "POST") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      res.write(
        `data: ${JSON.stringify({ type: "responding", node: "response_compose", content: "Cost profile ready.", status: "completed" })}\n\n`,
      );
      res.end();
      return;
    }
    if (url.pathname === `/api/projects/${project.id}/diagram-image`) {
      assert.equal(req.headers.authorization, "Bearer test-token");
      assert.equal(url.searchParams.get("user_id"), user.id);
      res.writeHead(200, {
        "Content-Type": "image/svg+xml",
        "X-CloudEval-Diagram-Auth-Mode": "bearer",
        "X-CloudEval-Diagram-Graph-Private": "1",
        "X-CloudEval-Diagram-Labels": url.searchParams.get("labels") || "all",
      });
      res.end("<svg>mcp</svg>");
      return;
    }
    if (
      url.pathname === `/api/v1/projects/${project.id}/graph/insights` &&
      req.method === "GET"
    ) {
      assert.equal(req.headers.authorization, "Bearer test-token");
      assert.equal(url.searchParams.get("user_id"), user.id);
      assert.equal(url.searchParams.get("focus"), "blast_radius");
      assert.equal(url.searchParams.get("resource_id"), "vm-1");
      return json(res, {
        project_id: project.id,
        focus: "blast_radius",
        insights: [{ resource_id: "vm-1", affected_resources: 3 }],
      });
    }
    if (
      url.pathname === "/api/v1/rule/template/validate" &&
      req.method === "POST"
    ) {
      assert.equal(url.searchParams.get("user_id"), user.id);
      const payload = JSON.parse(body || "{}");
      assert.equal(payload.template.resources[0].name, "sttest001");
      assert.equal(payload.parameter_file.parameters.location.value, "eastus2");
      assert.deepEqual(payload.options.rule_names, [
        "storage-public-access",
        "storage-encryption",
      ]);
      return json(res, {
        success: true,
        summary: { total_rules: 1, passed_rules: 0, failed_rules: 1 },
        requested_rule_names: payload.options.rule_names,
      });
    }
    if (url.pathname === "/api/v1/rule/rules/search" && req.method === "GET") {
      assert.equal(url.searchParams.get("query"), "public network");
      return json(res, {
        success: true,
        total_results: 1,
        results: [{ rule_name: "storage-public-access" }],
      });
    }
    return json(res, { detail: `Unhandled ${req.method} ${url.pathname}` }, 404);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
};

const cliInvocation = () => {
  const explicit = process.env.CLOUDEVAL_CLI_BIN;
  if (explicit) {
    return { command: path.resolve(explicit), prefix: [] as string[] };
  }
  return {
    command: process.execPath,
    prefix: [path.join(packageRoot, "node_modules/tsx/dist/cli.mjs"), "src/cli.tsx"],
  };
};

type McpTestTransport = "newline" | "content-length";

const startMcp = async (
  args: string[] = [],
  options: { transport?: McpTestTransport } = {},
) => {
  const transport = options.transport ?? "newline";
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-mcp-test-home-"));
  const { command, prefix } = cliInvocation();
  const child = spawn(command, [...prefix, "mcp", "serve", ...args], {
    cwd: packageRoot,
    env: {
      ...process.env,
      HOME: home,
      CI: "true",
      CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE: "1",
      CLOUDEVAL_ACCESS_KEY: "",
      CLOUDEVAL_API_KEY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  let childExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.on("exit", (code, signal) => {
    childExit = { code, signal };
  });

  let stdoutBuffer = Buffer.alloc(0);
  const messages: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];

  const readContentLengthMessages = () => {
    while (stdoutBuffer.length) {
      const headerEnd = stdoutBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const header = stdoutBuffer.subarray(0, headerEnd).toString("ascii");
      const contentLength = header.match(/^Content-Length:\s*(\d+)$/im);
      assert(contentLength, `Missing MCP Content-Length header in stdout: ${header}`);
      const bodyStart = headerEnd + 4;
      const bodyLength = Number(contentLength[1]);
      const bodyEnd = bodyStart + bodyLength;
      if (stdoutBuffer.length < bodyEnd) {
        return;
      }
      const parsed = JSON.parse(stdoutBuffer.subarray(bodyStart, bodyEnd).toString("utf8"));
      stdoutBuffer = stdoutBuffer.subarray(bodyEnd);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(parsed);
        continue;
      }
      messages.push(parsed);
    }
  };

  const readNewlineMessages = () => {
    while (stdoutBuffer.length) {
      const lineEnd = stdoutBuffer.indexOf("\n");
      if (lineEnd === -1) {
        return;
      }
      const line = stdoutBuffer.subarray(0, lineEnd).toString("utf8").trim();
      stdoutBuffer = stdoutBuffer.subarray(lineEnd + 1);
      if (!line) {
        continue;
      }
      const parsed = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) {
        waiter(parsed);
        continue;
      }
      messages.push(parsed);
    }
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, Buffer.from(chunk)]);
    if (transport === "content-length") {
      readContentLengthMessages();
      return;
    }
    readNewlineMessages();
  });

  const send = (message: unknown) => {
    const body = JSON.stringify(message);
    if (transport === "content-length") {
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      return;
    }
    child.stdin.write(`${body}\n`);
  };
  const read = async (): Promise<any> => {
    if (messages.length) {
      return messages.shift();
    }
    if (childExit) {
      throw new Error(
        `MCP process exited before response: ${JSON.stringify(childExit)}. stderr:\n${Buffer.concat(stderr).toString("utf8")}`
      );
    }
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for MCP response. stderr:\n${Buffer.concat(stderr).toString("utf8")}`));
      }, MCP_RESPONSE_TIMEOUT_MS);
      const exitHandler = (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `MCP process exited before response: ${JSON.stringify({ code, signal })}. stderr:\n${Buffer.concat(stderr).toString("utf8")}`
          )
        );
      };
      child.once("exit", exitHandler);
      waiters.push((value) => {
        clearTimeout(timeout);
        child.off("exit", exitHandler);
        resolve(value);
      });
    });
  };
  const close = async () => {
    if (!child.stdin.destroyed) {
      child.stdin.end();
    }
    const exitCode = childExit
      ? childExit.code
      : await new Promise<number | null>((resolve) => {
          const timeout = setTimeout(() => {
            child.kill("SIGKILL");
          }, MCP_CLOSE_TIMEOUT_MS);
          child.on("exit", (code) => {
            clearTimeout(timeout);
            resolve(code);
          });
        });
    await fs.rm(home, { recursive: true, force: true });
    return {
      exitCode,
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
  };

  return { child, send, read, close, stderr };
};

const initialize = async (mcp: Awaited<ReturnType<typeof startMcp>>) => {
  mcp.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "cloudeval-test", version: "1.0.0" },
    },
  });
  const response = await mcp.read();
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.equal(response.result.capabilities.tools.listChanged, false);
  mcp.send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  return response;
};

test("mcp serve initializes, lists tools, and returns strict JSON-RPC stdout", async () => {
  const mcp = await startMcp(["--frontend-url", "https://app.example.test"]);
  try {
    await initialize(mcp);

    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await mcp.read();
    assert.equal(listed.id, 2);
    const names = listed.result.tools.map((tool: any) => tool.name);
    assert(names.every((name: string) => /^[A-Za-z0-9_]+$/.test(name)));
    for (const tool of listed.result.tools) {
      assert.equal(
        tool.inputSchema?.properties?.accessKey,
        undefined,
        `${tool.name} must not expose accessKey as a tool argument`
      );
    }
    assert(names.includes("ask"));
    assert(names.includes("projects_list"));
    assert(names.includes("projects_export_diagram"));
    assert(names.includes("projects_graph_insights"));
    assert(names.includes("template_validate"));
    assert(names.includes("rules_search"));
    const templateValidate = listed.result.tools.find(
      (tool: any) => tool.name === "template_validate",
    );
    assert.equal(templateValidate.inputSchema.properties.ruleId.type, "string");
    assert.deepEqual(templateValidate.inputSchema.properties.ruleNames.oneOf[1], {
      type: "array",
      items: { type: "string" },
    });
    assert(!names.includes("projects.exportDiagram"));
    assert(!names.includes("projects.diagramImage"));
    assert(names.includes("reports_run"));
    assert(names.includes("open_url"));

    mcp.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "open_url",
        arguments: {
          target: "project",
          projectId: "project-main",
          view: "both",
        },
      },
    });
    const called = await mcp.read();
    assert.equal(called.id, 3);
    assert.equal(called.result.isError, false);
    assert.equal(called.result.structuredContent.ok, true);
    assert.match(
      called.result.structuredContent.data.url,
      /^https:\/\/app\.example\.test\/app\/projects\/project-main\?view=both/
    );
  } finally {
    const closed = await mcp.close();
    assert.equal(closed.exitCode, 0, closed.stderr);
    assert.match(closed.stderr, /CloudEval MCP server started/);
  }
});

test("mcp tools ignore per-call accessKey arguments", async () => {
  const backend = await startBackend();
  const mcp = await startMcp(["--base-url", backend.baseUrl]);
  try {
    await initialize(mcp);
    mcp.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "projects_list",
        arguments: {
          accessKey: "test-token",
        },
      },
    });
    const response = await mcp.read();
    assert.equal(response.id, 2);
    assert.equal(response.result.isError, true);
    assert.doesNotMatch(JSON.stringify(response), /test-token/);
    assert.equal(
      backend.requests.some((request) => request.authorization === "Bearer test-token"),
      false
    );
  } finally {
    const closed = await mcp.close();
    assert.equal(closed.exitCode, 0, closed.stderr);
    await backend.close();
  }
});

test("mcp serve accepts legacy dotted tool names as call aliases", async () => {
  const mcp = await startMcp(["--frontend-url", "https://app.example.test"]);
  try {
    await initialize(mcp);

    mcp.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "open.url",
        arguments: {
          target: "project",
          projectId: "project-main",
          view: "both",
        },
      },
    });
    const called = await mcp.read();
    assert.equal(called.id, 2);
    assert.equal(called.result.isError, false);
    assert.equal(called.result.structuredContent.ok, true);
    assert.match(
      called.result.structuredContent.data.url,
      /^https:\/\/app\.example\.test\/app\/projects\/project-main\?view=both/
    );
  } finally {
    const closed = await mcp.close();
    assert.equal(closed.exitCode, 0, closed.stderr);
  }
});

test("mcp agent_profiles_run uses canonical Agent Profile id", async () => {
  const backend = await startBackend();
  const mcp = await startMcp([
    "--base-url",
    backend.baseUrl,
    "--access-key",
    "test-token",
  ]);
  try {
    await initialize(mcp);

    mcp.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "agent_profiles_run",
        arguments: {
          profileId: "cost",
          projectId: "project-main",
          prompt: "thinking progress",
        },
      },
    });
    const called = await mcp.read();
    assert.equal(called.id, 2);
    assert.equal(called.result.isError, false);
    assert.equal(called.result.structuredContent.data.profile.id, "cost");
    assert.equal(called.result.structuredContent.data.response, "Cost profile ready.");

    const streamRequest = backend.requests.find(
      (request) => request.path === "/api/v1/chat/stream",
    );
    assert(streamRequest);
    const payload = JSON.parse(streamRequest.body);
    assert.equal(payload.agent_profile_id, "cost");
    assert.equal(payload.input.agent_profile_id, "cost");
  } finally {
    const closed = await mcp.close();
    assert.equal(closed.exitCode, 0, closed.stderr);
    await backend.close();
  }
});

test("mcp agent_profiles_list and get fall back to bundled profiles when backend requires authentication", async () => {
  const backend = await startBackend({ agentProfilesStatus: 401 });
  const mcp = await startMcp(["--base-url", backend.baseUrl]);
  try {
    await initialize(mcp);

    mcp.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "agent_profiles_list",
        arguments: {},
      },
    });
    const listed = await mcp.read();
    assert.equal(listed.id, 2);
    assert.equal(listed.result.isError, false);
    assert.deepEqual(
      listed.result.structuredContent.data.profiles.map((profile: any) => profile.id),
      ["architecture", "cost", "triage", "remediation"],
    );

    mcp.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "agent_profiles_get",
        arguments: { profileId: "architecture" },
      },
    });
    const shown = await mcp.read();
    assert.equal(shown.id, 3);
    assert.equal(shown.result.isError, false);
    assert.equal(shown.result.structuredContent.data.profile.id, "architecture");
    assert.equal(
      shown.result.structuredContent.data.profile.display_name,
      "Architecture",
    );
  } finally {
    const closed = await mcp.close();
    assert.equal(closed.exitCode, 0, closed.stderr);
    await backend.close();
  }
});

test("mcp serve accepts legacy Content-Length framed clients", async () => {
  const mcp = await startMcp([], { transport: "content-length" });
  try {
    await initialize(mcp);

    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await mcp.read();
    assert.equal(listed.id, 2);
    assert(listed.result.tools.length > 0);
  } finally {
    const closed = await mcp.close();
    assert.equal(closed.exitCode, 0, closed.stderr);
  }
});

test("mcp serve filters tools by safety toolset", async () => {
  const mcp = await startMcp(["--toolset", "readonly"]);
  try {
    await initialize(mcp);

    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await mcp.read();
    const names = listed.result.tools.map((tool: any) => tool.name);
    for (const expected of [
      "capabilities_get",
      "projects_list",
      "projects_get",
      "projects_graph_get",
      "projects_graph_timeline",
      "projects_graph_diff",
      "projects_graph_insights",
      "projects_graph_sync_runs",
      "connections_list",
      "connections_get",
      "reports_list",
      "reports_show",
      "reports_cost",
      "reports_waf",
      "reports_rules",
      "rules_categories",
      "rules_search",
      "rules_get",
      "billing_summary",
      "billing_usage",
      "billing_ledger",
      "billing_plans",
      "billing_topups",
      "billing_invoices",
      "billing_notifications",
      "models_list",
      "models_default_get",
      "sessions_list",
      "sessions_get",
      "sessions_search",
      "sessions_export",
      "identity_get",
      "auth_status",
      "status",
      "doctor",
      "config_show",
      "config_get",
      "config_profiles",
      "credentials_templates",
      "credentials_list",
      "credentials_inspect",
      "recipes_list",
      "recipes_get",
    ]) {
      assert(names.includes(expected), `${expected} should be available in readonly`);
    }
    for (const forbidden of [
      "ask",
      "reports_run",
      "reports_download",
      "projects_export_diagram",
      "template_validate",
      "template_parse",
      "credentials_create",
      "credentials_revoke",
      "billing_topup_checkout",
      "models_default_set",
    ]) {
      assert.equal(names.includes(forbidden), false, `${forbidden} must not be available in readonly`);
    }

    mcp.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "reports_run", arguments: {} },
    });
    const blocked = await mcp.read();
    assert.equal(blocked.id, 3);
    assert.equal(blocked.error.code, -32602);
    assert.match(blocked.error.message, /not available in toolset readonly/);
  } finally {
    const closed = await mcp.close();
    assert.equal(closed.exitCode, 0, closed.stderr);
  }
});

test("mcp serve filters resources and prompts by focused toolset", async () => {
  const mcp = await startMcp(["--toolset", "billing"]);
  try {
    await initialize(mcp);

    mcp.send({ jsonrpc: "2.0", id: 2, method: "resources/list" });
    const resources = await mcp.read();
    const resourceUris = resources.result.resources.map((resource: any) => resource.uri);
    assert.deepEqual(resourceUris, [
      "cloudeval://capabilities",
      "cloudeval://billing/summary",
    ]);

    mcp.send({
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: "cloudeval://projects" },
    });
    const blockedResource = await mcp.read();
    assert.equal(blockedResource.error.code, -32602);
    assert.match(blockedResource.error.message, /not available in toolset billing/);

    mcp.send({ jsonrpc: "2.0", id: 4, method: "prompts/list" });
    const prompts = await mcp.read();
    const promptNames = prompts.result.prompts.map((prompt: any) => prompt.name);
    assert(promptNames.includes("cloudeval-billing-review"));
    assert(promptNames.includes("cloudeval-credit-topup-readiness"));

    mcp.send({
      jsonrpc: "2.0",
      id: 5,
      method: "prompts/get",
      params: { name: "cloudeval-cloud-cost-review", arguments: {} },
    });
    const blockedPrompt = await mcp.read();
    assert.equal(blockedPrompt.error.code, -32602);
    assert.match(blockedPrompt.error.message, /not available in toolset billing/);
  } finally {
    const closed = await mcp.close();
    assert.equal(closed.exitCode, 0, closed.stderr);
  }
});

test("mcp serve exposes CloudEval resources and prompts", async () => {
  const mcp = await startMcp(["--frontend-url", "https://app.example.test"]);
  try {
    const initialized = await initialize(mcp);
    assert.equal(initialized.result.capabilities.resources.listChanged, false);
    assert.equal(initialized.result.capabilities.prompts.listChanged, false);

    mcp.send({ jsonrpc: "2.0", id: 2, method: "resources/list" });
    const resources = await mcp.read();
    assert.equal(resources.id, 2);
    const resourceUris = resources.result.resources.map((resource: any) => resource.uri);
    assert(resourceUris.includes("cloudeval://capabilities"));
    assert(resourceUris.includes("cloudeval://projects"));
    assert(resourceUris.includes("cloudeval://billing/summary"));
    assert(resourceUris.includes("cloudeval://reports/latest"));
    assert(resourceUris.includes("cloudeval://recipes"));

    mcp.send({
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: "cloudeval://capabilities" },
    });
    const resource = await mcp.read();
    assert.equal(resource.id, 3);
    assert.equal(resource.result.contents[0].uri, "cloudeval://capabilities");
    const capabilityPayload = JSON.parse(resource.result.contents[0].text);
    const packageJson = JSON.parse(
      await fs.readFile(path.join(packageRoot, "package.json"), "utf8")
    );
    assert.equal(capabilityPayload.cliVersion, packageJson.version);
    assert(capabilityPayload.mcp.tools.includes("projects_list"));
    assert(capabilityPayload.mcp.tools.includes("projects_export_diagram"));
    assert(capabilityPayload.mcp.tools.includes("projects_graph_insights"));
    assert(capabilityPayload.mcp.tools.includes("template_validate"));
    assert(capabilityPayload.mcp.tools.includes("rules_search"));
    assert(capabilityPayload.mcp.tools.includes("recipes_list"));
    assert(capabilityPayload.mcp.tools.includes("recipes_run"));
    assert(!capabilityPayload.mcp.tools.includes("projects.exportDiagram"));
    assert(!capabilityPayload.mcp.tools.includes("projects.diagramImage"));

    mcp.send({ jsonrpc: "2.0", id: 4, method: "prompts/list" });
    const prompts = await mcp.read();
    assert.equal(prompts.id, 4);
    const promptNames = prompts.result.prompts.map((prompt: any) => prompt.name);
    for (const expected of [
      "cloudeval-cloud-cost-review",
      "cloudeval-well-architected-framework-review",
      "cloudeval-architecture-review",
      "cloudeval-template-project-review",
      "cloudeval-report-summary",
      "cloudeval-report-generation-plan",
      "cloudeval-report-export-pack",
      "cloudeval-billing-review",
      "cloudeval-credit-topup-readiness",
      "cloudeval-project-inventory",
      "cloudeval-project-healthcheck",
      "cloudeval-connection-audit",
      "cloudeval-agent-access-key-setup",
      "cloudeval-credential-rotation",
      "cloudeval-model-selection",
      "cloudeval-session-recovery",
      "cloudeval-cli-onboarding-check",
      "cloudeval-frontend-workspace-links",
      "cloudeval-diagram-export",
      "cloudeval-architecture-diagram-export",
      "cloudeval-dependency-diagram-export",
      "cloudeval-mcp-setup",
    ]) {
      assert(promptNames.includes(expected), `${expected} prompt should be exposed`);
    }
    assert.equal(promptNames.includes("waf-triage"), false);
    assert.equal(promptNames.includes("cost-review"), false);

    mcp.send({
      jsonrpc: "2.0",
      id: 5,
      method: "prompts/get",
      params: {
        name: "cloudeval-cloud-cost-review",
        arguments: { projectId: "project-main", range: "30d" },
      },
    });
    const prompt = await mcp.read();
    assert.equal(prompt.id, 5);
    assert.match(prompt.result.messages[0].content.text, /project-main/);
    assert.match(prompt.result.messages[0].content.text, /30d/);

    mcp.send({
      jsonrpc: "2.0",
      id: 6,
      method: "prompts/get",
      params: {
        name: "waf-triage",
        arguments: { projectId: "project-main" },
      },
    });
    const aliasedPrompt = await mcp.read();
    assert.equal(aliasedPrompt.id, 6);
    assert.match(aliasedPrompt.result.messages[0].content.text, /project-main/);
    assert.match(aliasedPrompt.result.messages[0].content.text, /Well-Architected/i);

    mcp.send({
      jsonrpc: "2.0",
      id: 7,
      method: "resources/read",
      params: { uri: "cloudeval://recipes" },
    });
    const recipeResource = await mcp.read();
    assert.equal(recipeResource.id, 7);
    const recipePayload = JSON.parse(recipeResource.result.contents[0].text);
    assert.equal(recipePayload.ok, true);
    assert.equal(recipePayload.data.recipes.some((recipe: any) => recipe.id === "cloudeval-cloud-cost-review"), true);
  } finally {
    const closed = await mcp.close();
    assert.equal(closed.exitCode, 0, closed.stderr);
  }
});

test("mcp recipe tools expose catalog and keep recipe runs out of readonly toolset", async () => {
  const readonly = await startMcp(["--toolset", "readonly"]);
  try {
    await initialize(readonly);

    readonly.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "recipes_list", arguments: {} },
    });
    const listed = await readonly.read();
    assert.equal(listed.result.isError, false);
    assert.equal(listed.result.structuredContent.command, "recipes list");

    readonly.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "recipes_run", arguments: { recipeId: "cloudeval-cloud-cost-review" } },
    });
    const blocked = await readonly.read();
    assert.equal(blocked.error.code, -32602);
    assert.match(blocked.error.message, /not available in toolset readonly/);
  } finally {
    const closed = await readonly.close();
    assert.equal(closed.exitCode, 0, closed.stderr);
  }
});

test("mcp tools can call authenticated CloudEval APIs without stdin credentials", async () => {
  const backend = await startBackend();
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-mcp-image-"));
  const mcp = await startMcp([
    "--base-url",
    backend.baseUrl,
    "--frontend-url",
    "https://app.example.test",
    "--access-key",
    "test-token",
  ]);
  try {
    await initialize(mcp);
    mcp.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "projects_list",
        arguments: {},
      },
    });
    const response = await mcp.read();
    assert.equal(response.id, 2);
    assert.equal(response.result.isError, false);
    assert.equal(response.result.structuredContent.command, "projects list");
    assert.equal(response.result.structuredContent.data[0].id, "project-main");
    assert.equal(
      backend.requests.some((request) => request.authorization === "Bearer test-token"),
      true
    );

    const absoluteOutputPath = path.join(outputDir, "dependency.svg");
    const outputPath = path.relative(packageRoot, absoluteOutputPath);
    mcp.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "projects_export_diagram",
        arguments: {
          projectId: "project-main",
          frontendUrl: new URL(backend.baseUrl).origin,
          layout: "dependency",
          format: "svg",
          labels: "all",
          outputPath,
        },
      },
    });
    const imageResponse = await mcp.read();
    assert.equal(imageResponse.id, 3);
    assert.equal(imageResponse.result.isError, false);
    assert.equal(imageResponse.result.structuredContent.command, "projects export-diagram");
    assert.equal(
      imageResponse.result.structuredContent.data.outputPath,
      absoluteOutputPath,
    );
    assert.deepEqual(imageResponse.result.structuredContent.filesWritten, [
      absoluteOutputPath,
    ]);
    assert.equal(await fs.readFile(absoluteOutputPath, "utf8"), "<svg>mcp</svg>");
    assert(
      backend.requests.some(
        (request) =>
          request.path === "/api/projects/project-main/diagram-image" &&
          request.query.get("layout") === "dependency" &&
          request.query.get("format") === "svg" &&
          request.query.get("labels") === "all" &&
          request.query.get("user_id") === user.id &&
          request.authorization === "Bearer test-token",
      ),
    );

    const legacyOutputPath = path.join(outputDir, "legacy.svg");
    mcp.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "projects.diagramImage",
        arguments: {
          projectId: "project-main",
          frontendUrl: new URL(backend.baseUrl).origin,
          layout: "dependency",
          format: "svg",
          labels: "all",
          outputPath: legacyOutputPath,
        },
      },
    });
    const legacyImageResponse = await mcp.read();
    assert.equal(legacyImageResponse.id, 4);
    assert.equal(legacyImageResponse.result.isError, false);
    assert.equal(
      legacyImageResponse.result.structuredContent.command,
      "projects export-diagram",
    );
    assert.equal(await fs.readFile(legacyOutputPath, "utf8"), "<svg>mcp</svg>");
  } finally {
    const closed = await mcp.close();
    assert.equal(closed.exitCode, 0, closed.stderr);
    await fs.rm(outputDir, { recursive: true, force: true });
    await backend.close();
  }
});

test("mcp server exposes graph intelligence and generic validation tools", async () => {
  const backend = await startBackend();
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-mcp-validation-"));
  const templatePath = path.join(outputDir, "template.json");
  const parametersPath = path.join(outputDir, "parameters.json");
  await fs.writeFile(templatePath, JSON.stringify(templateFixture), "utf8");
  await fs.writeFile(parametersPath, JSON.stringify(parameterFileFixture), "utf8");

  const mcp = await startMcp([
    "--base-url",
    backend.baseUrl,
    "--access-key",
    "test-token",
  ]);
  try {
    await initialize(mcp);

    mcp.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "projects_graph_insights",
        arguments: {
          projectId: "project-main",
          focus: "impact",
          resourceId: "vm-1",
        },
      },
    });
    const insightsResponse = await mcp.read();
    assert.equal(insightsResponse.id, 2);
    assert.equal(insightsResponse.result.isError, false);
    assert.equal(
      insightsResponse.result.structuredContent.command,
      "projects graph insights",
    );
    assert.equal(
      insightsResponse.result.structuredContent.data.insights[0].affected_resources,
      3,
    );

    mcp.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "template_validate",
        arguments: {
          templatePath,
          parametersPath,
          failedOnly: true,
          ruleId: "storage-public-access",
          ruleNames: ["storage-encryption"],
        },
      },
    });
    const validationResponse = await mcp.read();
    assert.equal(validationResponse.id, 3);
    assert.equal(validationResponse.result.isError, false);
    assert.equal(
      validationResponse.result.structuredContent.command,
      "validate template",
    );
    assert.equal(validationResponse.result.structuredContent.data.summary.failed_rules, 1);
    assert.deepEqual(
      validationResponse.result.structuredContent.data.requested_rule_names,
      ["storage-public-access", "storage-encryption"],
    );

    mcp.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "rules_search",
        arguments: { query: "public network" },
      },
    });
    const rulesResponse = await mcp.read();
    assert.equal(rulesResponse.id, 4);
    assert.equal(rulesResponse.result.isError, false);
    assert.equal(rulesResponse.result.structuredContent.command, "rules search");
    assert.equal(
      rulesResponse.result.structuredContent.data.results[0].rule_name,
      "storage-public-access",
    );
  } finally {
    const closed = await mcp.close();
    assert.equal(closed.exitCode, 0, closed.stderr);
    await fs.rm(outputDir, { recursive: true, force: true });
    await backend.close();
  }
});
