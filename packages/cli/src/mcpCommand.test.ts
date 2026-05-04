import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

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
  const requests: Array<{ path: string; authorization?: string }> = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    await collectBody(req);
    requests.push({ path: url.pathname, authorization: req.headers.authorization });

    if (url.pathname === "/api/v1/auth/me") {
      return json(res, user);
    }
    if (url.pathname === `/api/v1/projects/user/${user.id}`) {
      return json(res, [project]);
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

const startMcp = async (args: string[] = []) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-mcp-test-home-"));
  const { command, prefix } = cliInvocation();
  const child = spawn(command, [...prefix, "mcp", "serve", ...args], {
    cwd: packageRoot,
    env: {
      ...process.env,
      HOME: home,
      CI: "true",
      CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE: "1",
      CLOUDEVAL_API_KEY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const messages: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  lines.on("line", (line) => {
    const parsed = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) {
      waiter(parsed);
      return;
    }
    messages.push(parsed);
  });

  const send = (message: unknown) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const read = async (): Promise<any> => {
    if (messages.length) {
      return messages.shift();
    }
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for MCP response. stderr:\n${Buffer.concat(stderr).toString("utf8")}`));
      }, 5000);
      waiters.push((value) => {
        clearTimeout(timeout);
        resolve(value);
      });
    });
  };
  const close = async () => {
    child.stdin.end();
    const exitCode = await new Promise<number | null>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);
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
};

test("mcp serve initializes, lists tools, and returns strict JSON-RPC stdout", async () => {
  const mcp = await startMcp(["--frontend-url", "https://app.example.test"]);
  try {
    await initialize(mcp);

    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await mcp.read();
    assert.equal(listed.id, 2);
    const names = listed.result.tools.map((tool: any) => tool.name);
    assert(names.includes("ask"));
    assert(names.includes("projects.list"));
    assert(names.includes("reports.run"));
    assert(names.includes("open.url"));

    mcp.send({
      jsonrpc: "2.0",
      id: 3,
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
  }
});

test("mcp tools can call authenticated CloudEval APIs without stdin credentials", async () => {
  const backend = await startBackend();
  const mcp = await startMcp([
    "--base-url",
    backend.baseUrl,
    "--frontend-url",
    "https://app.example.test",
    "--api-key",
    "test-token",
  ]);
  try {
    await initialize(mcp);
    mcp.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "projects.list",
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
  } finally {
    const closed = await mcp.close();
    assert.equal(closed.exitCode, 0, closed.stderr);
    await backend.close();
  }
});
