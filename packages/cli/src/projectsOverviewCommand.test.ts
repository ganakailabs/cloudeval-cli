import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Command } from "commander";
import { registerProjectsCommand } from "./projectsCommand.js";

const user = {
  id: "user-1",
  email: "engineer@example.test",
  preferences: { onboarding: { completedAt: "2026-07-07T00:00:00.000Z" } },
};

const project = {
  id: "project-main",
  name: "Production Review",
  cloud_provider: "azure",
  project_data_source: "live-sync",
  type: "sync",
  connection_ids: ["conn-azure"],
  resource_count: 2,
};

function sendJson(res: http.ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function startServer() {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(`${req.method} ${url.pathname}`);

    if (req.method === "GET" && url.pathname === "/api/v1/auth/me") {
      sendJson(res, user);
      return;
    }
    if (req.method === "GET" && url.pathname === `/api/v1/projects/user/${user.id}`) {
      sendJson(res, [project]);
      return;
    }
    if (req.method === "GET" && url.pathname === `/api/v1/connection/user/${user.id}`) {
      sendJson(res, [
        {
          id: "conn-azure",
          name: "Azure Production",
          cloud_provider: "azure",
          status: "connected",
          project_id: project.id,
        },
        {
          id: "conn-other",
          name: "Other Connection",
          cloud_provider: "aws",
          status: "connected",
          project_id: "other-project",
        },
      ]);
      return;
    }
    if (req.method === "GET" && url.pathname.replace(/\/+$/, "") === "/api/v1/reports/history") {
      sendJson(res, {
        items: [
          {
            report_id: "report-cost",
            report_type: "cost",
            project_id: project.id,
            generated_at: "2026-07-07T08:00:00.000Z",
            status: "available",
          },
          {
            report_id: "report-waf",
            report_type: "architecture",
            project_id: project.id,
            generated_at: "2026-07-07T09:00:00.000Z",
            status: "warning",
          },
        ],
      });
      return;
    }
    if (req.method === "GET" && url.pathname === `/api/v1/projects/${project.id}/graph`) {
      sendJson(res, {
        graph: {
          nodes: [
            { id: "storage", name: "storage", resource_type: "Microsoft.Storage/storageAccounts" },
            { id: "nsg", name: "nsg", resource_type: "Microsoft.Network/networkSecurityGroups" },
          ],
          edges: [{ source: "nsg", target: "storage", type: "DEPENDS_ON" }],
          latest_sync_version: "sync-1",
          last_updated_at: "2026-07-07T09:30:00.000Z",
        },
      });
      return;
    }
    if (req.method === "GET" && url.pathname === `/api/v1/projects/${project.id}/graph/insights`) {
      sendJson(res, { status: "needs_attention", focus: url.searchParams.get("focus") });
      return;
    }
    if (req.method === "GET" && url.pathname === `/api/v1/projects/${project.id}/graph/timeline`) {
      sendJson(res, [{ sync_version: "sync-1", created_at: "2026-07-07T09:30:00.000Z" }]);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/billing/entitlement") {
      sendJson(res, {
        data: {
          plan: { id: "pro", name: "Pro Monthly" },
          balance: {
            credits_total: 1000,
            credits_used: 250,
            credits_remaining: 750,
            credits_total_effective: 1000,
            credits_remaining_effective: 750,
          },
        },
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/billing/usage/summary") {
      sendJson(res, { total_credits: 250 });
      return;
    }

    sendJson(res, { detail: "not found" }, 404);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function runProjectsOverview(baseUrl: string, outputPath: string): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.name("cloudeval");
  registerProjectsCommand(program, {
    defaultBaseUrl: baseUrl,
    resolveBaseUrl: async (options) => options.baseUrl ?? baseUrl,
    readStdinValue: async () => "test-token",
    isHeadlessEnvironment: () => true,
  });

  await program.parseAsync([
    "node",
    "cloudeval",
    "projects",
    "overview",
    project.id,
    "--base-url",
    baseUrl,
    "--access-key-stdin",
    "--non-interactive",
    "--format",
    "json",
    "--output",
    outputPath,
  ]);
}

test("projects overview returns IDE envelope with project graph, reports, connections, and credits", async () => {
  const server = await startServer();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-projects-overview-"));
  try {
    const outputPath = path.join(tempDir, "overview.json");
    await runProjectsOverview(server.baseUrl, outputPath);
    const output = await fs.readFile(outputPath, "utf8");
    const envelope = JSON.parse(output);
    const frontend = "http://localhost:3000";

    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, "projects overview");
    assert.equal(envelope.schemaVersion, "2026-07-ide-v1");
    assert.equal(envelope.frontendUrl, `${frontend}/app/projects/${project.id}`);
    assert.equal(envelope.data.project.id, project.id);
    assert.equal(envelope.data.connections.length, 1);
    assert.equal(envelope.data.connections[0].id, "conn-azure");
    assert.equal(envelope.data.reports.latestReportAt, "2026-07-07T09:00:00.000Z");
    assert.equal(envelope.data.reports.costStatus, "available");
    assert.equal(envelope.data.reports.wellArchitectedStatus, "available");
    assert.equal(envelope.data.reports.issuesStatus, "needs_attention");
    assert.equal(envelope.data.graph.available, true);
    assert.equal(envelope.data.graph.nodeCount, 2);
    assert.equal(envelope.data.graph.edgeCount, 1);
    assert.equal(envelope.data.graph.latestSyncVersion, "sync-1");
    assert.equal(envelope.data.deepLinks.architectureUrl, `${frontend}/app/projects/${project.id}?view=preview&layout=architecture`);
    assert.equal(envelope.data.deepLinks.dependencyUrl, `${frontend}/app/projects/${project.id}?view=preview&layout=dependency`);
    assert.equal(envelope.data.credits.status.planName, "Pro Monthly");
    assert.ok(server.requests.includes("GET /api/v1/auth/me"));
    assert.ok(server.requests.includes(`GET /api/v1/projects/${project.id}/graph`));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    await server.close();
  }
});
