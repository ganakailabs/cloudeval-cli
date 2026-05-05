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

const startBackend = async (
  options: {
    models?: Array<Record<string, unknown>>;
  } = {}
) => {
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
    if (url.pathname === "/api/v1/models") {
      return json(res, {
        models: options.models ?? [
          { id: "gpt-5-nano", name: "GPT-5 Nano" },
          { id: "gpt-5-mini", name: "GPT-5 Mini" },
        ],
      });
    }
    if (url.pathname === `/api/v1/projects/user/${user.id}`) {
      return json(res, [project, ...createdProjects]);
    }
    if (url.pathname === `/api/projects/${project.id}/diagram-image`) {
      const format = url.searchParams.get("format") || "png";
      const isPublic = url.searchParams.get("public") === "1";
      if (!isPublic) {
        assert.equal(req.headers.authorization, "Bearer test-token");
        assert.equal(url.searchParams.get("user_id"), user.id);
      }
      const contentType =
        format === "svg"
          ? "image/svg+xml"
          : format === "jpeg"
            ? "image/jpeg"
            : "image/png";
      res.writeHead(200, {
        "Content-Type": contentType,
        "X-CloudEval-Diagram-Auth-Mode": isPublic ? "public" : "bearer",
        "X-CloudEval-Diagram-Graph-Private": isPublic ? "0" : "1",
        "X-CloudEval-Diagram-Labels": url.searchParams.get("labels") || "all",
      });
      res.end(format === "svg" ? "<svg>mock</svg>" : "mock-image-bytes");
      return;
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
      return json(res, {
        packs: [
          {
            id: "starter",
            name: "Starter",
            credits: 1000,
            price_usd: 9,
            display_currency: "USD",
            display_price_major: 9,
          },
        ],
      });
    }
    if (url.pathname === "/api/v1/billing/checkout/session/top-up" && req.method === "POST") {
      return json(res, {
        session_id: "cs_topup_1",
        flow_type: "top_up",
        status: "created",
        expires_at: "2026-05-04T03:00:00",
        checkout_mode: "standard_checkout",
        checkout_url: null,
        launcher_url: "https://app.example.test/app/subscription/checkout-launcher?session_id=cs_topup_1",
        resolved_currency: "USD",
        display_amount_major: 9,
        payment_methods: { card: true },
      });
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
  options: { input?: string; env?: Record<string, string>; timeoutMs?: number; home?: string } = {}
) => {
  const home = options.home ?? await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-cli-test-home-"));
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
  if (!options.home) {
    await fs.rm(home, { recursive: true, force: true });
  }

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

const parseJsonError = (result: Awaited<ReturnType<typeof runCli>>) => {
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
};

test("non-interactive discovery commands are machine-readable", async () => {
  const capabilities = parseJson(await runCli(["capabilities", "--format", "json"]));
  assert.equal(capabilities.ok, true);
  assert.deepEqual(
    ["ask", "reports download", "projects create", "mcp serve"].every((command) =>
      JSON.stringify(capabilities.data.domains).includes(command)
    ),
    true
  );

  const completion = await runCli(["completion", "zsh"]);
  assert.equal(completion.exitCode, 0, completion.stderr);
  assert.match(completion.stdout, /_cloudeval/);
});

test("phase one and two local commands are agent-safe and profile-aware", async () => {
  const backend = await startBackend();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-cli-phase12-home-"));
  try {
    const setup = parseJson(await runCli([
      "setup",
      "--non-interactive",
      "--base-url",
      backend.baseUrl,
      "--frontend-url",
      "https://app.example.test",
      "--project",
      "project-main",
      "--model",
      "gpt-5-mini",
      "--profile",
      "agent",
      "--format",
      "json",
    ], { home }));
    assert.equal(setup.command, "setup");
    assert.equal(setup.data.config.baseUrl, backend.baseUrl);
    assert.equal(setup.data.config.defaultProjectId, "project-main");

    const config = parseJson(await runCli(["config", "show", "--profile", "agent", "--format", "json"], { home }));
    assert.equal(config.command, "config show");
    assert.equal(config.data.baseUrl, backend.baseUrl);
    assert.equal(config.data.model, "gpt-5-mini");

    const configPath = await runCli(["config", "path", "--profile", "agent"], { home });
    assert.equal(configPath.exitCode, 0, configPath.stderr);
    assert.match(configPath.stdout, /settings\.json/);

    const modelDefault = parseJson(await runCli(["models", "default", "get", "--profile", "agent", "--format", "json"], { home }));
    assert.equal(modelDefault.data.model, "gpt-5-mini");

    const models = parseJson(await runCli([
      "models",
      "list",
      "--api-key",
      "test-token",
      "--profile",
      "agent",
      "--format",
      "json",
    ], { home }));
    assert.equal(models.command, "models list");
    assert.equal(models.data.models[1].id, "gpt-5-mini");

    const status = parseJson(await runCli(["status", "--profile", "agent", "--format", "json"], { home }));
    assert.equal(status.command, "status");
    assert.equal(status.data.baseUrl, backend.baseUrl);
    assert.equal(status.data.auth.authenticated, false);

    const doctor = parseJson(await runCli(["doctor", "--profile", "agent", "--format", "json"], { home }));
    assert.equal(doctor.command, "doctor");
    assert.equal(doctor.data.ok, true);
    assert.equal(doctor.data.checks.some((check: any) => check.id === "base-url-secure"), true);

    const mcpDoctor = parseJson(await runCli(["doctor", "--profile", "agent", "--mcp", "--format", "json"], { home }));
    assert.equal(mcpDoctor.command, "doctor");
    assert.equal(mcpDoctor.data.ok, true);
    assert.equal(mcpDoctor.data.checks.some((check: any) => check.id === "mcp-tools-list"), true);
    assert.equal(mcpDoctor.data.mcp.toolsets.includes("readonly"), true);

    const capabilities = parseJson(await runCli(["capabilities", "--format", "json"], { home }));
    assert.equal(JSON.stringify(capabilities.data.domains).includes("doctor"), true);
    assert.equal(JSON.stringify(capabilities.data.domains).includes("sessions list"), true);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await backend.close();
  }
});

test("mcp status and setup helpers are machine-readable", async () => {
  const status = parseJson(await runCli(["mcp", "status", "--format", "json"]));
  assert.equal(status.command, "mcp status");
  assert.equal(status.data.protocolVersion, "2025-06-18");
  assert.equal(status.data.toolsets.includes("readonly"), true);
  assert.equal(status.data.resources.includes("cloudeval://capabilities"), true);
  assert.equal(status.data.prompts.includes("cost-review"), true);
  assert.equal(status.data.setupClients.includes("generic"), true);

  const setup = parseJson(await runCli([
    "mcp",
    "setup",
    "codex",
    "--dry-run",
    "--command",
    "/usr/local/bin/cloudeval",
    "--toolset",
    "readonly",
    "--format",
    "json",
  ]));
  assert.equal(setup.command, "mcp setup");
  assert.equal(setup.data.client, "codex");
  assert.deepEqual(setup.data.server.args, ["mcp", "serve", "--toolset", "readonly"]);
  assert.match(setup.data.instructions[0], /codex mcp add cloudeval/);

  const genericSetup = parseJson(await runCli([
    "mcp",
    "setup",
    "generic",
    "--dry-run",
    "--command",
    "cloudeval",
    "--toolset",
    "readonly",
    "--format",
    "json",
  ]));
  assert.equal(genericSetup.command, "mcp setup");
  assert.equal(genericSetup.data.client, "generic");
  assert.equal(genericSetup.data.configPath, undefined);
  assert.deepEqual(genericSetup.data.config, {
    mcpServers: {
      cloudeval: {
        command: "cloudeval",
        args: ["mcp", "serve", "--toolset", "readonly"],
      },
    },
  });
  assert.match(genericSetup.data.instructions[0], /Copy the shown mcpServers\.cloudeval entry/);
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

    const frontendUrl = new URL(backend.baseUrl).origin;
    const imageOutput = path.join(outputDir, "architecture.png");
    const headersOutput = path.join(outputDir, "architecture.headers");
    const relativeImageOutput = path.relative(path.resolve("."), imageOutput);
    const relativeHeadersOutput = path.relative(path.resolve("."), headersOutput);
    const image = await runCli([
      "projects",
      "export-diagram",
      "project-main",
      "--base-url",
      backend.baseUrl,
      "--frontend-url",
      frontendUrl,
      "--api-key",
      "test-token",
      "--layout",
      "architecture",
      "--format",
      "png",
      "--labels",
      "all",
      "--output",
      relativeImageOutput,
      "--headers-output",
      relativeHeadersOutput,
      "--non-interactive",
    ]);
    assert.equal(image.exitCode, 0, image.stderr);
    assert.match(
      image.stdout,
      new RegExp(`Downloaded architecture diagram to ${imageOutput.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
    assert.equal(await fs.readFile(imageOutput, "utf8"), "mock-image-bytes");
    const imageHeaders = await fs.readFile(headersOutput, "utf8");
    assert.match(imageHeaders, /x-cloudeval-diagram-auth-mode: bearer/i);
    assert.match(imageHeaders, /x-cloudeval-diagram-labels: all/i);
    assert(
      backend.requests.some(
        (request) =>
          request.path === "/api/projects/project-main/diagram-image" &&
          request.query.get("layout") === "architecture" &&
          request.query.get("format") === "png" &&
          request.query.get("labels") === "all" &&
          request.query.get("user_id") === user.id &&
          request.authorization === "Bearer test-token",
      ),
    );

    const missingImageRequestsBefore = backend.requests.filter(
      (request) => request.path === "/api/projects/missing-project/diagram-image",
    ).length;
    const missingImage = await runCli([
      "projects",
      "export-diagram",
      "missing-project",
      "--base-url",
      backend.baseUrl,
      "--frontend-url",
      frontendUrl,
      "--api-key",
      "test-token",
      "--layout",
      "architecture",
      "--format",
      "png",
      "--labels",
      "all",
      "--output",
      path.join(outputDir, "missing.png"),
      "--non-interactive",
    ]);
    assert.equal(missingImage.exitCode, 1);
    assert.match(missingImage.stderr, /Project missing-project was not found/);
    assert.equal(
      backend.requests.filter(
        (request) => request.path === "/api/projects/missing-project/diagram-image",
      ).length,
      missingImageRequestsBefore,
    );

    const publicImageOutput = path.join(outputDir, "dependency.svg");
    const publicHeadersOutput = path.join(outputDir, "dependency.headers");
    const publicImage = await runCli([
      "projects",
      "export-diagram",
      "project-main",
      "--frontend-url",
      frontendUrl,
      "--public",
      "--layout",
      "dependency",
      "--format",
      "svg",
      "--labels",
      "viewport",
      "--output",
      path.relative(path.resolve("."), publicImageOutput),
      "--headers-output",
      path.relative(path.resolve("."), publicHeadersOutput),
      "--json",
      "--non-interactive",
    ]);
    assert.equal(publicImage.exitCode, 0, publicImage.stderr);
    assert.equal(await fs.readFile(publicImageOutput, "utf8"), "<svg>mock</svg>");
    const publicImagePayload = JSON.parse(publicImage.stdout);
    assert.equal(publicImagePayload.data.output, publicImageOutput);
    assert.equal(publicImagePayload.data.headersOutput, publicHeadersOutput);
    assert.deepEqual(publicImagePayload.filesWritten, [
      publicImageOutput,
      publicHeadersOutput,
    ]);
    assert(
      backend.requests.some(
        (request) =>
          request.path === "/api/projects/project-main/diagram-image" &&
          request.query.get("layout") === "dependency" &&
          request.query.get("format") === "svg" &&
          request.query.get("labels") === "viewport" &&
          request.query.get("public") === "1" &&
          !request.authorization,
      ),
    );

    const projectsHelp = await runCli(["projects", "--help"]);
    assert.equal(projectsHelp.exitCode, 0, projectsHelp.stderr);
    assert.match(projectsHelp.stdout, /export-diagram \[options\] <id>/);
    assert.doesNotMatch(projectsHelp.stdout, /diagram-image/);

    const legacyImageOutput = path.join(outputDir, "legacy.png");
    const legacyImage = await runCli([
      "projects",
      "diagram-image",
      "project-main",
      "--frontend-url",
      frontendUrl,
      "--public",
      "--layout",
      "architecture",
      "--format",
      "png",
      "--labels",
      "all",
      "--output",
      legacyImageOutput,
      "--non-interactive",
    ]);
    assert.equal(legacyImage.exitCode, 0, legacyImage.stderr);
    assert.equal(await fs.readFile(legacyImageOutput, "utf8"), "mock-image-bytes");
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

    const topups = parseJson(await runCli(["billing", "topups", ...common]));
    assert.equal(topups.data.packs[0].id, "starter");

    const checkout = parseJson(await runCli([
      "billing",
      "topup",
      "starter",
      ...common,
      "--currency",
      "USD",
      "--country-code",
      "US",
      "--frontend-url",
      "https://app.example.test",
      "--no-open",
    ]));
    assert.equal(checkout.command, "billing topup");
    assert.equal(checkout.data.packId, "starter");
    assert.equal(checkout.data.session.session_id, "cs_topup_1");
    assert.equal(
      checkout.data.checkoutUrl,
      "https://app.example.test/app/subscription/checkout-launcher?session_id=cs_topup_1"
    );

    const checkoutRequest = backend.requests.find(
      (request) => request.path === "/api/v1/billing/checkout/session/top-up"
    );
    assert(checkoutRequest);
    assert.equal(checkoutRequest.method, "POST");
    assert.deepEqual(JSON.parse(checkoutRequest.body), {
      pack_id: "starter",
      preferred_currency: "USD",
      country_code: "US",
      return_to: "https://app.example.test/app/subscription?tab=billing",
    });
  } finally {
    await backend.close();
  }
});

test("billing auth failures preserve JSON output", async () => {
  const plans = parseJsonError(await runCli(["billing", "plans", "--format", "json", "--non-interactive"]));
  assert.equal(plans.ok, false);
  assert.equal(plans.command, "billing plans");
  assert.match(plans.error.message, /No authentication available/);

  const topups = parseJsonError(await runCli(["billing", "topups", "--format", "json", "--non-interactive"]));
  assert.equal(topups.ok, false);
  assert.equal(topups.command, "billing topups");
  assert.match(topups.error.message, /No authentication available/);
});

test("ask streams a single answer non-interactively with selected project and model", async () => {
  const backend = await startBackend();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-cli-session-home-"));
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
      "--thread",
      "thread-reuse",
      "--format",
      "json",
      "--non-interactive",
      "--print-url",
      "--no-open",
      "--frontend-url",
      "https://app.example.test",
    ], { home }));
    assert.equal(answer.command, "ask");
    assert.equal(answer.data.response, "Mock answer from Cloudeval AI.");
    assert.equal(answer.data.project.id, "project-main");

    const sessions = parseJson(await runCli(["sessions", "list", "--format", "json"], { home }));
    assert.equal(sessions.command, "sessions list");
    assert.equal(sessions.data[0].threadId, answer.data.threadId);
    assert.equal(sessions.data[0].projectId, "project-main");

    const session = parseJson(await runCli(["sessions", "get", answer.data.threadId, "--format", "json"], { home }));
    assert.equal(session.data.messages[0].role, "user");
    assert.equal(session.data.messages.at(-1).content, "Mock answer from Cloudeval AI.");

    const search = parseJson(await runCli(["sessions", "search", "Mock answer", "--format", "json"], { home }));
    assert.equal(search.command, "sessions search");
    assert.equal(search.data[0].threadId, answer.data.threadId);

    const renamed = parseJson(await runCli([
      "sessions",
      "rename",
      answer.data.threadId,
      "Reusable thread",
      "--format",
      "json",
    ], { home }));
    assert.equal(renamed.command, "sessions rename");
    assert.equal(renamed.data.title, "Reusable thread");

    const streamRequest = backend.requests.find((request) => request.path === "/api/v1/chat/stream");
    assert(streamRequest);
    const payload = JSON.parse(streamRequest.body);
    assert.equal(payload.thread_id, "thread-reuse");
    assert.equal(payload.project.id, "project-main");
    assert.equal(payload.settings.model, "gpt-5-mini");
    assert.equal(streamRequest.authorization, "Bearer test-token");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await backend.close();
  }
});

test("ask rejects unavailable backend models before opening a chat stream", async () => {
  const backend = await startBackend({
    models: [{ id: "gpt-5-nano", name: "GPT-5 Nano" }],
  });
  try {
    const result = await runCli([
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
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Model 'gpt-5-mini' is not available/);
    assert.match(result.stderr, /gpt-5-nano/);
    assert.equal(
      backend.requests.some((request) => request.path === "/api/v1/chat/stream"),
      false
    );
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
