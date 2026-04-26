import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import test from "node:test";

type RecordedRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: string;
  authorization?: string;
};

const user = {
  id: "user-1",
  email: "prateek@example.test",
  full_name: "Prateek Singh",
  preferences: { onboarding: { completedAt: "2026-04-26T00:00:00.000Z" } },
};

const project = {
  id: "project-main",
  name: "Playground",
  user_id: user.id,
  cloud_provider: "azure",
  type: "template",
  connection_ids: ["conn-main"],
};

const connection = {
  id: "conn-main",
  user_id: user.id,
  name: "Azure Template Connection",
  cloud_provider: "azure",
  type: "template",
};

const costReport = {
  id: "cost-current",
  kind: "cost",
  projectId: project.id,
  generatedAt: "2026-04-26T00:00:00.000Z",
  source: { provider: "azure" },
  raw: { total: 42, currency: "USD" },
  parsed: {
    totalSpend: { amount: 42, currency: "USD", changePercent: 3 },
    estimatedSavings: { amount: 7, currency: "USD", percentOfSpend: 16.6 },
    serviceGroups: [{ name: "Compute", amount: 30, currency: "USD", changePercent: 2 }],
    recommendations: [
      { id: "rec-1", title: "Rightsize VM", monthlySavings: 7, currency: "USD", risk: "low" },
    ],
    anomalies: [],
    budgets: [],
    trend: [{ date: "2026-04-26", amount: 42, currency: "USD" }],
  },
  formatted: {
    title: "Cost Report",
    summary: "Current spend is $42.",
    sections: [{ id: "summary", title: "Summary", markdown: "Spend is controlled." }],
  },
};

const wafReport = {
  id: "waf-current",
  kind: "waf",
  projectId: project.id,
  generatedAt: "2026-04-26T00:00:00.000Z",
  source: { provider: "azure" },
  raw: { score: 91 },
  parsed: {
    score: {
      overall: 91,
      pillars: [{ id: "security", label: "Security", score: 91, passed: 9, warned: 1, failed: 0 }],
    },
    counts: { passed: 9, highRisk: 0, mediumRisk: 1, evidenceCoveragePercent: 95 },
    rules: [
      {
        id: "SEC-1",
        pillar: "security",
        title: "Enable managed identity",
        status: "warn",
        severity: "medium",
      },
    ],
  },
  formatted: {
    title: "WAF Report",
    summary: "Architecture is mostly healthy.",
    sections: [{ id: "security", title: "Security", markdown: "Review identity posture." }],
  },
};

const json = (res: http.ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};

const collectBody = async (req: http.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const startBackend = async () => {
  const requests: RecordedRequest[] = [];
  const createdProjects: any[] = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = await collectBody(req);
    const record: RecordedRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body,
      authorization: req.headers.authorization,
    };
    requests.push(record);

    if (url.pathname === "/api/v1/auth/me") {
      return json(res, user);
    }
    if (url.pathname === `/api/v1/projects/user/${user.id}`) {
      return json(res, [project, ...createdProjects]);
    }
    if (url.pathname === "/api/v1/connection/" && req.method === "POST") {
      return json(res, { ...connection, id: "conn-created", sync_status: { status: "queued" } }, 201);
    }
    if (url.pathname === "/api/v1/projects/" && req.method === "POST") {
      const payload = JSON.parse(body || "{}");
      const created = {
        ...project,
        id: "project-created",
        name: payload.name ?? "Created Project",
        connection_ids: payload.connection_ids ?? ["conn-created"],
      };
      createdProjects.push(created);
      return json(res, created, 201);
    }
    if (url.pathname === `/api/v1/connection/user/${user.id}`) {
      return json(res, [connection]);
    }
    if (url.pathname === "/api/v1/reports/history") {
      return json(res, {
        user_id: user.id,
        items: [
          {
            report_id: costReport.id,
            project_id: project.id,
            project_name: project.name,
            report_type: "cost",
            generated_at: costReport.generatedAt,
            is_latest: true,
            status: "completed",
            metrics: { monthly_cost: 42, currency: "USD", monthly_savings: 7 },
          },
          {
            report_id: wafReport.id,
            project_id: project.id,
            project_name: project.name,
            report_type: "architecture",
            generated_at: wafReport.generatedAt,
            is_latest: true,
            status: "completed",
            metrics: { overall_score: 91, high_count: 0, medium_count: 1 },
          },
        ],
        total_count: 2,
      });
    }
    if (url.pathname === `/api/v1/reports/detail/${project.id}/cost`) {
      return json(res, {
        project_id: project.id,
        report_type: "cost",
        timestamp: costReport.generatedAt,
        is_latest: true,
        report: costReport,
      });
    }
    if (url.pathname === `/api/v1/reports/detail/${project.id}/architecture`) {
      return json(res, {
        project_id: project.id,
        report_type: "architecture",
        timestamp: wafReport.generatedAt,
        is_latest: true,
        report: wafReport,
      });
    }
    if (url.pathname === "/api/v1/reports") {
      return json(res, [costReport, wafReport]);
    }
    if (url.pathname === "/api/v1/reports/cost") {
      return json(res, costReport);
    }
    if (url.pathname === "/api/v1/reports/waf") {
      return json(res, wafReport);
    }
    if (url.pathname === "/api/v1/reports/cost-current") {
      return json(res, costReport);
    }
    if (url.pathname === `/api/v1/cost-reports/${project.id}/full`) {
      return json(res, { raw: costReport.raw, parsed: costReport.parsed, formatted: costReport.formatted });
    }
    if (url.pathname === `/api/v1/well-architected-reports/${project.id}/full`) {
      return json(res, { raw: wafReport.raw, parsed: wafReport.parsed, formatted: wafReport.formatted });
    }
    if (url.pathname === `/api/v1/cost-reports/${project.id}/regenerate` && req.method === "POST") {
      return json(res, {
        message: "Cost report regeneration job submitted",
        job: { job_id: "job-cost-1", status: "submitted", operation: "cost_report_regenerate" },
        project_id: project.id,
      }, 202);
    }
    if (url.pathname === `/api/v1/well-architected-reports/${project.id}/regenerate` && req.method === "POST") {
      return json(res, {
        message: "Well-Architected report regeneration job submitted",
        job: { job_id: "job-waf-1", status: "submitted", operation: "waf_report_regenerate" },
        project_id: project.id,
      }, 202);
    }
    if (url.pathname === `/api/v1/reports/${project.id}/unit-tests/regenerate` && req.method === "POST") {
      return json(res, {
        message: "Unit test report regeneration job submitted",
        job: { job_id: "job-tests-1", status: "submitted", operation: "run_unit_tests" },
        project_id: project.id,
      }, 202);
    }
    if (url.pathname === "/api/v1/jobs/job-cost-1") {
      return json(res, { job_id: "job-cost-1", status: "completed", progress: 100 });
    }
    if (url.pathname === "/api/v1/billing/config") {
      return json(res, { plans: [{ id: "free", name: "Free", price_usd: 0 }] });
    }
    if (url.pathname === "/api/v1/billing/entitlement") {
      return json(res, {
        data: {
          plan: { id: "free", name: "Free", price_usd: 0 },
          balance: { credits_total: 150, credits_used: 10, credits_remaining: 140 },
        },
      });
    }
    if (url.pathname === "/api/v1/billing/subscription/status") {
      return json(res, { status: "active", plan_id: "free" });
    }
    if (url.pathname === "/api/v1/billing/usage/summary") {
      return json(res, { total_events: 2, total_credits: 3, buckets: [] });
    }
    if (url.pathname === "/api/v1/billing/usage/ledger") {
      return json(res, { items: [{ id: "usage-1", credits: 1 }], next_cursor: null });
    }
    if (url.pathname === "/api/v1/billing/subscription/billing-info") {
      return json(res, { invoices: [{ id: "inv-1", amount_due: 0 }] });
    }
    if (url.pathname === "/api/v1/billing/top-up/packs") {
      return json(res, { packs: [{ id: "pack-1", credits: 100 }] });
    }
    if (url.pathname === "/api/v1/billing/notifications") {
      return json(res, { notifications: [{ id: "note-1", type: "credit_low" }] });
    }
    if (url.pathname === "/api/v1/chat/stream" && req.method === "POST") {
      const payload = JSON.parse(body || "{}");
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      res.write(`data: ${JSON.stringify({ type: "metadata", thread_id: "thread-test", trace_id: "trace-test" })}\n\n`);
      if (String(payload.message ?? "").includes("duplicate chunks")) {
        res.write(`data: ${JSON.stringify({ type: "responding", node: "generate_response", content: "Mock duplicate answer." })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "responding", node: "generate_response", content: "Mock duplicate answer." })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: "responding", node: "generate_response", content: "Mock answer from Cloudeval AI." })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    return json(res, { detail: `Unhandled ${req.method} ${url.pathname}` }, 404);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

const cliInvocation = () => {
  const explicit = process.env.CLOUDEVAL_CLI_BIN;
  if (explicit) {
    return { command: path.resolve(explicit), prefix: [] as string[] };
  }
  return {
    command: path.resolve("node_modules/.bin/tsx"),
    prefix: ["src/cli.tsx"],
  };
};

const runCli = async (
  args: string[],
  options: { input?: string; env?: Record<string, string>; timeoutMs?: number } = {}
) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-cli-test-home-"));
  const { command, prefix } = cliInvocation();
  const child = spawn(command, [...prefix, ...args], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      HOME: home,
      CI: "true",
      CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE: "1",
      CLOUDEVAL_HEADLESS_LOGIN: "1",
      CLOUDEVAL_API_KEY: "",
      ...options.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (options.input) {
    child.stdin.end(options.input);
  } else {
    child.stdin.end();
  }

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

  const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 20_000);
  const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  clearTimeout(timeout);
  await fs.rm(home, { recursive: true, force: true });

  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
};

const parseJson = (result: Awaited<ReturnType<typeof runCli>>) => {
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test("non-interactive discovery commands are machine-readable", async () => {
  const capabilities = parseJson(await runCli(["capabilities", "--format", "json"]));
  assert.equal(capabilities.ok, true);
  assert.deepEqual(
    ["ask", "reports download", "projects create"].every((command) =>
      JSON.stringify(capabilities.data.domains).includes(command)
    ),
    true
  );

  const completion = await runCli(["completion", "zsh"]);
  assert.equal(completion.exitCode, 0, completion.stderr);
  assert.match(completion.stdout, /_cloudeval/);
});

test("auth status is non-interactive and respects explicit base url", async () => {
  const backend = await startBackend();
  try {
    const result = await runCli(["auth", "status", "--base-url", backend.baseUrl]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Authenticated: no/);
    assert.match(result.stdout, new RegExp(`CLI API URL: ${backend.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    await backend.close();
  }
});

test("project creation, project reads, output files, and stdin API key work non-interactively", async () => {
  const backend = await startBackend();
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-project-output-"));
  try {
    const create = parseJson(await runCli([
      "projects",
      "create",
      "--base-url",
      backend.baseUrl,
      "--api-key",
      "test-token",
      "--template-url",
      "https://github.com/Azure/azure-quickstart-templates/blob/main/quickstarts/microsoft.compute/vm-simple-linux/azuredeploy.json",
      "--name",
      "CLI Created Project",
      "--description",
      "Created by non-interactive test",
      "--provider",
      "azure",
      "--format",
      "json",
      "--frontend-url",
      "https://app.example.test",
      "--no-open",
    ]));
    assert.equal(create.command, "projects create");
    assert.equal(create.data.project.id, "project-created");
    assert.equal(create.data.connection.id, "conn-created");
    assert.match(create.frontendUrl, /https:\/\/app\.example\.test\/app\/projects\/project-created/);

    const list = await runCli([
      "projects",
      "list",
      "--base-url",
      backend.baseUrl,
      "--api-key-stdin",
      "--format",
      "ndjson",
      "--non-interactive",
    ], { input: "stdin-token\n" });
    assert.equal(list.exitCode, 0, list.stderr);
    assert.match(list.stdout, /"id":"project-main"/);

    const textList = await runCli([
      "projects",
      "list",
      "--base-url",
      backend.baseUrl,
      "--api-key",
      "test-token",
      "--format",
      "text",
      "--non-interactive",
    ]);
    assert.equal(textList.exitCode, 0, textList.stderr);
    assert.match(textList.stdout, /^ID\s+Name\s+Provider\s+Source\s+Status\s+Updated/m);
    assert.match(textList.stdout, /project-main\s+Playground\s+azure/);
    assert.doesNotMatch(textList.stdout, /dashboard:/);
    assert.doesNotMatch(textList.stdout, /reports:/);

    const output = path.join(outputDir, "project.json");
    const get = await runCli([
      "projects",
      "get",
      "project-main",
      "--base-url",
      backend.baseUrl,
      "--api-key",
      "test-token",
      "--format",
      "json",
      "--output",
      output,
      "--non-interactive",
    ]);
    assert.equal(get.exitCode, 0, get.stderr);
    assert.equal(get.stdout, "");
    const saved = JSON.parse(await fs.readFile(output, "utf8"));
    assert.equal(saved.data.id, "project-main");
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
    await backend.close();
  }
});

test("connections and frontend deeplinks run without opening browsers", async () => {
  const backend = await startBackend();
  try {
    const list = parseJson(await runCli([
      "connections",
      "list",
      "--base-url",
      backend.baseUrl,
      "--api-key",
      "test-token",
      "--format",
      "json",
      "--non-interactive",
    ]));
    assert.equal(list.data[0].id, "conn-main");

    const open = await runCli([
      "open",
      "project",
      "project-main",
      "--base-url",
      backend.baseUrl,
      "--frontend-url",
      "https://app.example.test",
      "--view",
      "both",
      "--layout",
      "dependency",
      "--node",
      "vm-1",
      "--print-url",
      "--no-open",
    ]);
    assert.equal(open.exitCode, 0, open.stderr);
    assert.match(open.stdout, /https:\/\/app\.example\.test\/app\/projects\/project-main/);
    assert.match(open.stdout, /view=both/);
    assert.match(open.stdout, /layout=dependency/);
  } finally {
    await backend.close();
  }
});

test("report list, show, cost, waf, rules, and download commands return report data", async () => {
  const backend = await startBackend();
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-report-output-"));
  try {
    const common = ["--base-url", backend.baseUrl, "--api-key", "test-token", "--project", "project-main", "--non-interactive"];

    const list = await runCli(["reports", "list", ...common, "--kind", "all", "--format", "json"]);
    assert.equal(list.exitCode, 0, list.stderr);
    const listed = JSON.parse(list.stdout);
    assert.equal(listed.length, 2);
    assert.equal(listed[0].id, "cost-current");

    const shown = parseJson(await runCli(["reports", "show", "cost-current", ...common, "--format", "json", "--parsed"]));
    assert.equal(shown.totalSpend.amount, 42);

    const cost = await runCli(["reports", "cost", ...common, "--period", "30d", "--format", "markdown", "--formatted"]);
    assert.equal(cost.exitCode, 0, cost.stderr);
    assert.match(cost.stdout, /# Cost Report/);

    const waf = await runCli(["reports", "waf", ...common, "--severity", "medium", "--format", "json", "--parsed"]);
    assert.equal(waf.exitCode, 0, waf.stderr);
    assert.equal(JSON.parse(waf.stdout).score.overall, 91);

    const rules = parseJson(await runCli(["reports", "rules", ...common, "--format", "json"]));
    assert.equal(rules.command, "reports rules");
    assert.equal(rules.data[0].id, "SEC-1");

    const run = parseJson(await runCli([
      "reports",
      "run",
      ...common,
      "--type",
      "cost",
      "--format",
      "json",
      "--no-open",
    ]));
    assert.equal(run.command, "reports run");
    assert.equal(run.data.projectId, "project-main");
    assert.deepEqual(run.data.jobs, ["job-cost-1"]);

    const download = parseJson(await runCli([
      "reports",
      "download",
      ...common,
      "--type",
      "all",
      "--view",
      "raw",
      "--output",
      outputDir,
      "--format",
      "json",
      "--frontend-url",
      "https://app.example.test",
      "--no-open",
    ]));
    assert.equal(download.command, "reports download");
    assert.equal(download.data.filesWritten.length, 2);
    assert.deepEqual((await fs.readdir(outputDir)).sort(), [
      "project-main-cost-report.json",
      "project-main-waf-report.json",
    ]);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
    await backend.close();
  }
});

test("billing and credits commands are non-interactive and JSON-safe", async () => {
  const backend = await startBackend();
  try {
    const common = ["--base-url", backend.baseUrl, "--api-key", "test-token", "--format", "json", "--non-interactive"];
    const credits = parseJson(await runCli(["credits", ...common]));
    assert.equal(credits.command, "credits");
    assert.equal(credits.data.entitlement.plan.id, "free");

    const summary = parseJson(await runCli(["billing", "summary", ...common]));
    assert.equal(summary.data.subscriptionStatus.status, "active");

    const usage = parseJson(await runCli(["billing", "usage", ...common, "--range", "7d", "--granularity", "day"]));
    assert.equal(usage.data.total_events, 2);

    const ledger = parseJson(await runCli(["billing", "ledger", ...common, "--limit", "5"]));
    assert.equal(ledger.data.items[0].id, "usage-1");

    const plans = parseJson(await runCli(["billing", "plans", ...common]));
    assert.equal(plans.data.plans[0].id, "free");
  } finally {
    await backend.close();
  }
});

test("ask streams a single answer non-interactively with selected project and model", async () => {
  const backend = await startBackend();
  try {
    const answer = parseJson(await runCli([
      "ask",
      "What can you do?",
      "--base-url",
      backend.baseUrl,
      "--api-key",
      "test-token",
      "--project",
      "project-main",
      "--model",
      "gpt-5-mini",
      "--format",
      "json",
      "--non-interactive",
      "--print-url",
      "--no-open",
      "--frontend-url",
      "https://app.example.test",
    ]));
    assert.equal(answer.command, "ask");
    assert.equal(answer.data.response, "Mock answer from Cloudeval AI.");
    assert.equal(answer.data.project.id, "project-main");

    const streamRequest = backend.requests.find((request) => request.path === "/api/v1/chat/stream");
    assert(streamRequest);
    const payload = JSON.parse(streamRequest.body);
    assert.equal(payload.project.id, "project-main");
    assert.equal(payload.settings.model, "gpt-5-mini");
    assert.equal(streamRequest.authorization, "Bearer test-token");
  } finally {
    await backend.close();
  }
});

test("ask accepts unquoted multi-word text and keeps progress separate from pipeable data", async () => {
  const backend = await startBackend();
  try {
    const text = await runCli([
      "ask",
      "duplicate",
      "chunks",
      "--base-url",
      backend.baseUrl,
      "--api-key",
      "test-token",
      "--project",
      "project-main",
      "--format",
      "text",
      "--progress",
      "stderr",
      "--non-interactive",
    ]);
    assert.equal(text.exitCode, 0, text.stderr);
    assert.equal(text.stdout, "Mock duplicate answer.\n");
    assert.match(text.stderr, /\[auth\] Resolving authentication/);
    assert.match(text.stderr, /\[request\] Sending chat request/);

    const streamRequest = [...backend.requests]
      .reverse()
      .find((request) => request.path === "/api/v1/chat/stream");
    assert(streamRequest);
    assert.equal(JSON.parse(streamRequest.body).message, "duplicate chunks");

    const ndjson = await runCli([
      "ask",
      "What can you do?",
      "--base-url",
      backend.baseUrl,
      "--api-key",
      "test-token",
      "--project",
      "project-main",
      "--format",
      "ndjson",
      "--progress",
      "ndjson",
      "--non-interactive",
    ]);
    assert.equal(ndjson.exitCode, 0, ndjson.stderr);
    const events = ndjson.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ["auth", "request", "request", "chunk", "result"]);
    assert.equal(events.at(-1).data.response, "Mock answer from Cloudeval AI.");
  } finally {
    await backend.close();
  }
});
