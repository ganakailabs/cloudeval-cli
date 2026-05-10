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

const startBackend = async () => {
  const requests: Array<{ path: string; query: URLSearchParams; authorization?: string }> = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    await collectBody(req);
    requests.push({ path: url.pathname, query: url.searchParams, authorization: req.headers.authorization });

    if (url.pathname === "/api/v1/auth/me") {
      return json(res, user);
    }
    if (url.pathname === `/api/v1/projects/user/${user.id}`) {
      return json(res, [project]);
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
    assert(names.includes("ask"));
    assert(names.includes("projects_list"));
    assert(names.includes("projects_export_diagram"));
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
    assert.deepEqual(names, [
      "capabilities_get",
      "projects_list",
      "projects_get",
      "connections_list",
      "connections_get",
      "reports_list",
      "billing_summary",
      "billing_usage",
      "billing_ledger",
      "billing_plans",
      "billing_topups",
      "models_list",
      "auth_status",
      "status",
      "doctor",
      "recipes_list",
      "recipes_get",
    ]);

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
    assert.deepEqual(promptNames, ["billing-review"]);

    mcp.send({
      jsonrpc: "2.0",
      id: 5,
      method: "prompts/get",
      params: { name: "cost-review", arguments: {} },
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
    assert(capabilityPayload.mcp.tools.includes("recipes_list"));
    assert(capabilityPayload.mcp.tools.includes("recipes_run"));
    assert(!capabilityPayload.mcp.tools.includes("projects.exportDiagram"));
    assert(!capabilityPayload.mcp.tools.includes("projects.diagramImage"));

    mcp.send({ jsonrpc: "2.0", id: 4, method: "prompts/list" });
    const prompts = await mcp.read();
    assert.equal(prompts.id, 4);
    const promptNames = prompts.result.prompts.map((prompt: any) => prompt.name);
    assert.deepEqual(promptNames, [
      "cost-review",
      "waf-triage",
      "architecture-review",
      "template-project-review",
      "report-summary",
      "billing-review",
      "diagram-export",
      "mcp-setup",
    ]);

    mcp.send({
      jsonrpc: "2.0",
      id: 5,
      method: "prompts/get",
      params: {
        name: "cost-review",
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
      method: "resources/read",
      params: { uri: "cloudeval://recipes" },
    });
    const recipeResource = await mcp.read();
    assert.equal(recipeResource.id, 6);
    const recipePayload = JSON.parse(recipeResource.result.contents[0].text);
    assert.equal(recipePayload.ok, true);
    assert.equal(recipePayload.data.recipes.some((recipe: any) => recipe.id === "cost-review"), true);
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
      params: { name: "recipes_run", arguments: { recipeId: "cost-review" } },
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
