import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import test from "node:test";
import { CLI_VERSION } from "./version.js";

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

const templateFixture = {
  $schema:
    "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  parameters: {
    location: { type: "string", defaultValue: "eastus" },
  },
  resources: [
    {
      type: "Microsoft.Storage/storageAccounts",
      apiVersion: "2022-09-01",
      name: "sttest001",
      location: "[parameters('location')]",
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

const credentialTemplate = {
  id: "ci",
  name: "GitHub Actions CI",
  description: "Run reports and read project findings from CI.",
  capabilities: ["projects:read", "reports:run", "reports:read"],
  default_expires_days: 90,
};

const credential = {
  id: "cred-main",
  type: "access_key",
  name: "github-actions-prod",
  status: "active",
  key_prefix: "cev_test_ak_01JTEST",
  key_suffix: "abcd",
  project_ids: [project.id],
  capabilities: ["projects:read", "reports:run", "reports:read"],
  expires_at: "2026-08-08T00:00:00.000Z",
  last_used_at: "2026-05-08T00:00:00.000Z",
};

const agentProfile = {
  id: "cost",
  display_name: "Cost",
  description:
    "Reviews project cost drivers, waste signals, and practical optimization opportunities.",
  personality: "Commercially pragmatic, specific, and action-oriented.",
  accent_key: "emerald",
  icon_key: "wallet",
  default_mode: "agent",
  starter_prompt: "Review live Azure sync cost posture.",
  starter_prompts: {
    template: "Review ARM/Bicep template cost risk.",
    sync: "Review live Azure sync cost posture.",
  },
  starter_prompt_variants: [
    {
      id: "cost-template-agent-a",
      project_source: "template",
      mode: "agent",
      text: "Review template cost evidence and next validation step.",
      weight: 1,
    },
    {
      id: "cost-template-agent-b",
      project_source: "template",
      mode: "agent",
      text: "Find one expensive template choice and a safe savings action.",
      weight: 1,
    },
    {
      id: "cost-template-ask-a",
      project_source: "template",
      mode: "ask",
      text: "Summarize one template cost risk.",
      weight: 1,
    },
    {
      id: "cost-sync-agent-a",
      project_source: "sync",
      mode: "agent",
      text: "Review live cost signals and savings evidence.",
      weight: 1,
    },
  ],
  default_settings: {
    mode: "agent",
    response_length: "Detailed",
    technicality: "Expert",
    reasoning_effort: "medium",
    max_tools: 12,
    max_tools_per_type: 6,
    enable_judge: true,
    enable_hitl: true,
  },
  required_capabilities: [
    "projects:read",
    "reports:read",
    "billing:read",
    "ask:run",
  ],
  allowed_toolsets: ["projects", "reports", "connections", "billing"],
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
    serviceGroups: [
      { name: "Compute", amount: 30, currency: "USD", changePercent: 2 },
    ],
    recommendations: [
      {
        id: "rec-1",
        title: "Rightsize VM",
        monthlySavings: 7,
        currency: "USD",
        risk: "low",
      },
    ],
    anomalies: [],
    budgets: [],
    trend: [{ date: "2026-04-26", amount: 42, currency: "USD" }],
  },
  formatted: {
    title: "Cost Report",
    summary: "Current spend is $42.",
    sections: [
      { id: "summary", title: "Summary", markdown: "Spend is controlled." },
    ],
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
      pillars: [
        {
          id: "security",
          label: "Security",
          score: 91,
          passed: 9,
          warned: 1,
          failed: 0,
        },
      ],
    },
    counts: {
      passed: 9,
      highRisk: 0,
      mediumRisk: 1,
      evidenceCoveragePercent: 95,
    },
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
    sections: [
      {
        id: "security",
        title: "Security",
        markdown: "Review identity posture.",
      },
    ],
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
    authMeStatus?: number;
    agentProfilesStatus?: number;
    authUser?: typeof user;
    projects?: (typeof project)[];
  } = {},
) => {
  const requests: RecordedRequest[] = [];
  const createdProjects: any[] = [];
  const authUser = options.authUser ?? user;

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

    if (url.pathname === "/api/v1/auth/device/code" && req.method === "POST") {
      return json(res, {
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://cloudeval.ai/device/login",
        verification_uri_complete:
          "https://cloudeval.ai/device/login?user_code=ABCD-EFGH",
        expires_in: 60,
        interval: 1,
      });
    }
    if (url.pathname === "/api/v1/auth/device/token" && req.method === "POST") {
      return json(res, {
        access_token: "test-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url.pathname === "/api/v1/auth/me") {
      if (options.authMeStatus && options.authMeStatus >= 400) {
        return json(res, { detail: "Invalid token" }, options.authMeStatus);
      }
      return json(res, authUser);
    }
    if (url.pathname === "/api/v1/identity") {
      return json(res, {
        identity: {
          type: "user",
          id: authUser.id,
          email: authUser.email,
        },
        capabilities: ["projects:read", "reports:run", "credentials:manage"],
        limits: { credits_remaining_today: 850, max_parallel_jobs: 3 },
      });
    }
    if (url.pathname === "/api/v1/capabilities") {
      return json(res, {
        product: "CloudEval",
        auth: { supports: ["oauth_device_flow", "access_key", "mcp_stdio"] },
        current_identity: {
          type: "user",
          id: authUser.id,
          email: authUser.email,
        },
        allowed_tools: [
          {
            name: "reports.run",
            risk: "low",
            required_capabilities: ["reports:run"],
            supports_dry_run: false,
          },
        ],
        limits: { credits_remaining_today: 850, max_parallel_jobs: 3 },
      });
    }
    if (
      (url.pathname === "/api/v1/projects" ||
        url.pathname === "/api/v1/projects/") &&
      req.method === "GET"
    ) {
      return json(res, [
        ...(options.projects ?? [project]),
        ...createdProjects,
      ]);
    }
    if (url.pathname === "/api/v1/credential-templates") {
      return json(res, { templates: [credentialTemplate] });
    }
    if (url.pathname === "/api/v1/credentials" && req.method === "GET") {
      assert.equal(url.searchParams.get("project_id"), project.id);
      return json(res, { credentials: [credential] });
    }
    if (url.pathname === "/api/v1/credentials" && req.method === "POST") {
      assert.equal(req.headers["idempotency-key"], "idem-create-1");
      const payload = JSON.parse(body || "{}");
      assert.equal(payload.template, "ci");
      assert.equal(payload.name, "github-actions-prod");
      assert.equal(payload.project_id, project.id);
      return json(
        res,
        {
          credential: {
            ...credential,
            id: "cred-created",
            name: payload.name,
            expires_at: "2026-08-07T00:00:00.000Z",
          },
          access_key: "cev_test_ak_01JTEST_createdsecret",
          project_id: payload.project_id,
        },
        201,
      );
    }
    if (url.pathname === "/api/v1/credentials/cred-main") {
      return json(res, {
        credential,
        audit_events: [{ id: "aud-1", event_type: "credential.used" }],
      });
    }
    if (
      url.pathname === "/api/v1/credentials/cred-main/revoke" &&
      req.method === "POST"
    ) {
      assert.equal(req.headers["idempotency-key"], "idem-revoke-1");
      const payload = JSON.parse(body || "{}");
      assert.equal(payload.reason, "rotated");
      return json(res, {
        credential: {
          ...credential,
          status: "revoked",
          revoked_at: "2026-05-09T00:00:00.000Z",
          revoke_reason: "rotated",
        },
      });
    }
    if (url.pathname === "/api/v1/models") {
      return json(res, {
        models: options.models ?? [
          { id: "gpt-5-nano", name: "GPT-5 Nano" },
          { id: "gpt-5-mini", name: "GPT-5 Mini" },
        ],
      });
    }
    if (url.pathname === "/api/v1/agent-profiles") {
      if (options.agentProfilesStatus) {
        return json(
          res,
          {
            error: "Authentication required for this endpoint",
            code: "AUTH_REQUIRED_PUBLIC",
            requiresAuth: true,
            signInUrl: "/auth?callbackUrl=%2Fplayground",
            method: "GET",
            path: "/api/v1/agent-profiles",
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
            signInUrl: "/auth?callbackUrl=%2Fplayground",
            method: "GET",
            path: "/api/v1/agent-profiles/cost",
          },
          options.agentProfilesStatus,
        );
      }
      if (url.pathname === "/api/v1/agent-profiles/cost") {
        return json(res, { profile: agentProfile });
      }
    }
    if (url.pathname === `/api/v1/projects/user/${authUser.id}`) {
      return json(res, [
        ...(options.projects ?? [project]),
        ...createdProjects,
      ]);
    }
    if (url.pathname === "/api/v1/onboard/quick" && req.method === "POST") {
      const payload = JSON.parse(body || "{}");
      assert.equal(payload.email, authUser.email);
      return json(
        res,
        {
          user: {
            ...authUser,
            preferences: {
              ...(authUser.preferences ?? {}),
              onboarding: {
                ...((authUser.preferences ?? {}).onboarding ?? {}),
                completedAt: "2026-05-09T00:00:00.000Z",
              },
            },
          },
          playground_project: project,
          default_connection: connection,
          onboarding_completed_at: "2026-05-09T00:00:00.000Z",
          setup_jobs: [
            { operation: "connection_template_sync", status: "background" },
            { operation: "project_template_blob_sync", status: "background" },
            { operation: "project_reports_autogen", status: "background" },
          ],
          next_steps: [],
        },
        201,
      );
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
    if (
      url.pathname === `/api/v1/projects/${project.id}/sync-runs` &&
      req.method === "GET"
    ) {
      assert.equal(req.headers.authorization, "Bearer test-token");
      assert.equal(url.searchParams.get("user_id"), user.id);
      return json(res, {
        project_id: project.id,
        active_sync_version: "sync-2",
        timeline_available: true,
        runs: [
          {
            sync_version: "sync-2",
            last_modified: "2026-05-17T00:00:00.000Z",
            changed: true,
          },
          {
            sync_version: "sync-1",
            last_modified: "2026-05-16T00:00:00.000Z",
            changed: true,
          },
        ],
      });
    }
    if (
      url.pathname === `/api/v1/projects/${project.id}/graph/timeline` &&
      req.method === "GET"
    ) {
      assert.equal(req.headers.authorization, "Bearer test-token");
      assert.equal(url.searchParams.get("user_id"), user.id);
      return json(res, {
        project_id: project.id,
        active_sync_version: "sync-2",
        timeline_available: true,
        runs: [{ sync_version: "sync-2", change_summary: { added: 1 } }],
      });
    }
    if (
      url.pathname === `/api/v1/projects/${project.id}/graph/diff` &&
      req.method === "GET"
    ) {
      assert.equal(req.headers.authorization, "Bearer test-token");
      assert.equal(url.searchParams.get("user_id"), user.id);
      assert.equal(url.searchParams.get("from"), "sync-1");
      assert.equal(url.searchParams.get("to"), "sync-2");
      return json(res, {
        project_id: project.id,
        from_sync_version: "sync-1",
        to_sync_version: "sync-2",
        summary: { added: 1, removed: 0, changed: 2 },
        diff: { nodes_added: ["storage-new"], nodes_changed: ["vm-1"] },
      });
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
        sync_version: "sync-2",
        insights: [
          {
            resource_id: "vm-1",
            title: "VM dependency impact",
            severity: "medium",
            affected_resources: 3,
          },
        ],
      });
    }
    if (
      url.pathname === `/api/v1/projects/${project.id}/graph` &&
      req.method === "GET"
    ) {
      assert.equal(req.headers.authorization, "Bearer test-token");
      assert.equal(url.searchParams.get("user_id"), user.id);
      return json(res, {
        project_id: project.id,
        nodes: [{ id: "vm-1", type: "Microsoft.Compute/virtualMachines" }],
        edges: [],
      });
    }
    if (url.pathname === "/api/v1/connection/" && req.method === "POST") {
      return json(
        res,
        {
          ...connection,
          id: "conn-created",
          sync_status: { status: "queued" },
        },
        201,
      );
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
      return json(res, {
        raw: costReport.raw,
        parsed: costReport.parsed,
        formatted: costReport.formatted,
      });
    }
    if (
      url.pathname === `/api/v1/well-architected-reports/${project.id}/full`
    ) {
      return json(res, {
        raw: wafReport.raw,
        parsed: wafReport.parsed,
        formatted: wafReport.formatted,
      });
    }
    if (
      url.pathname === `/api/v1/cost-reports/${project.id}/regenerate` &&
      req.method === "POST"
    ) {
      return json(
        res,
        {
          message: "Cost report regeneration job submitted",
          job: {
            job_id: "job-cost-1",
            status: "submitted",
            operation: "cost_report_regenerate",
          },
          project_id: project.id,
        },
        202,
      );
    }
    if (
      url.pathname ===
        `/api/v1/well-architected-reports/${project.id}/regenerate` &&
      req.method === "POST"
    ) {
      return json(
        res,
        {
          message: "Well-Architected report regeneration job submitted",
          job: {
            job_id: "job-waf-1",
            status: "submitted",
            operation: "waf_report_regenerate",
          },
          project_id: project.id,
        },
        202,
      );
    }
    if (
      url.pathname === `/api/v1/reports/${project.id}/unit-tests/regenerate` &&
      req.method === "POST"
    ) {
      return json(
        res,
        {
          message: "Unit test report regeneration job submitted",
          job: {
            job_id: "job-tests-1",
            status: "submitted",
            operation: "run_unit_tests",
          },
          project_id: project.id,
        },
        202,
      );
    }
    if (url.pathname === "/api/v1/jobs/job-cost-1") {
      return json(res, {
        job_id: "job-cost-1",
        status: "completed",
        progress: 100,
      });
    }
    if (url.pathname === "/api/v1/jobs/job-template-validation-1") {
      assert.equal(url.searchParams.get("user_id"), user.id);
      return json(res, {
        job_id: "job-template-validation-1",
        status: "SUCCEEDED",
        operation: "template_validate",
        progress: 100,
      });
    }
    if (url.pathname === "/api/v1/jobs/job-template-validation-1/result") {
      assert.equal(url.searchParams.get("user_id"), user.id);
      return json(res, {
        result: {
          success: true,
          summary: { total_rules: 1, passed_rules: 0, failed_rules: 1 },
          filtered_results: {
            total_matching_rules: 1,
            results: [{ rule_name: "async-template-validation", outcome: "Fail" }],
          },
        },
      });
    }
    if (url.pathname === "/api/v1/jobs/job-template-tests-1") {
      assert.equal(url.searchParams.get("user_id"), user.id);
      return json(res, {
        job_id: "job-template-tests-1",
        status: "SUCCEEDED",
        operation: "template_test",
        progress: 100,
      });
    }
    if (url.pathname === "/api/v1/jobs/job-template-tests-1/result") {
      assert.equal(url.searchParams.get("user_id"), user.id);
      return json(res, {
        result: {
          success: true,
          total_tests: 2,
          passed_tests: 1,
          failed_tests: 1,
          skipped_tests: 0,
          test_results: [
            {
              test_name: "Template Should Not Contain Blanks",
              test_category: "syntax",
              passed: true,
              severity: "info",
              message: "Template contains no blank elements.",
              recommendation: "No action required.",
              duration_ms: 12,
              file_path: "azuredeploy.json",
            },
            {
              test_name: "IDs Should Be Derived From ResourceIDs",
              test_category: "security",
              passed: false,
              severity: "error",
              message: "One resource id is not derived from resourceId().",
              recommendation: "Use resourceId() for resource identifiers.",
              duration_ms: 18,
              file_path: "azuredeploy.json",
            },
          ],
        },
      });
    }
    if (
      url.pathname === "/api/v1/rule/template/validate" &&
      req.method === "POST"
    ) {
      assert.equal(url.searchParams.get("user_id"), user.id);
      const payload = JSON.parse(body || "{}");
      assert.equal(payload.template.resources[0].type, "Microsoft.Storage/storageAccounts");
      if (payload.parameter_file !== undefined) {
        assert.equal(payload.parameter_file.parameters.location.value, "eastus2");
      }
      assert.equal(typeof payload.options.include_only_failed, "boolean");
      const selectedRules = Array.isArray(payload.options.rule_names)
        ? payload.options.rule_names
        : [];
      if (selectedRules.includes("async-template-validation")) {
        return json(
          res,
          {
            message: "Template validation job submitted",
            job: {
              job_id: "job-template-validation-1",
              status: "QUEUED",
              operation: "template_validate",
            },
          },
          202,
        );
      }
      return json(res, {
        success: true,
        summary:
          selectedRules.length > 0
            ? {
                total_rules: selectedRules.length,
                passed_rules: 0,
                failed_rules: selectedRules.length,
              }
            : { total_rules: 12, passed_rules: 10, failed_rules: 2 },
        requested_rule_names: selectedRules,
        filtered_results: {
          total_matching_rules: selectedRules.length > 0 ? selectedRules.length : 2,
          results: [
            {
              rule_name: "storage-public-access",
              outcome: "Fail",
              level: "Warning",
              target_name: "sttest001",
              target_type: "Microsoft.Storage/storageAccounts",
              info: {
                display_name: "Disable anonymous blob access",
                description: "Storage accounts should reject anonymous blob access.",
                synopsis: "Anonymous blob access increases data exposure risk.",
              },
              recommendation: "Set allowBlobPublicAccess to false.",
              documentation_url: "https://example.test/rules/storage-public-access",
            },
          ],
        },
      });
    }
    if (url.pathname === "/api/v1/arm-template/test" && req.method === "POST") {
      assert.equal(url.searchParams.get("user_id"), user.id);
      const payload = JSON.parse(body || "{}");
      assert.equal(payload.template.resources[0].name, "sttest001");
      assert.equal(payload.parameter_file.parameters.location.value, "eastus2");
      assert.deepEqual(payload.include_tests, ["IDs Should Be Derived From ResourceIDs"]);
      return json(
        res,
        {
          message: "Template test job submitted",
          job: {
            job_id: "job-template-tests-1",
            status: "QUEUED",
            operation: "template_test",
          },
        },
        202,
      );
    }
    if (url.pathname === "/api/v1/arm-template/parse" && req.method === "POST") {
      assert.equal(url.searchParams.get("user_id"), user.id);
      const payload = JSON.parse(body || "{}");
      assert.equal(payload.template.resources[0].name, "sttest001");
      if (payload.parameter_file !== undefined) {
        assert.equal(payload.parameter_file.parameters.location.value, "eastus2");
      }
      return json(res, {
        success: true,
        resource_count: 1,
        resources: [
          {
            type: "Microsoft.Storage/storageAccounts",
            name: "sttest001",
            apiVersion: "2022-09-01",
            location: "eastus",
          },
        ],
      });
    }
    if (url.pathname === "/api/v1/rule/rules/categories" && req.method === "GET") {
      return json(res, {
        success: true,
        total_categories: 1,
        categories: {
          security: {
            display_name: "Security",
            rule_count: 1,
            rules: [{ rule_name: "storage-public-access", severity: "Warning" }],
          },
        },
      });
    }
    if (url.pathname === "/api/v1/rule/rules/search" && req.method === "GET") {
      assert.equal(url.searchParams.get("query"), "public network");
      return json(res, {
        success: true,
        total_results: 1,
        results: [
          {
            rule_name: "storage-public-access",
            display_name: "Restrict public access",
            severity: "Warning",
            category: "security",
          },
        ],
      });
    }
    if (
      url.pathname === "/api/v1/rule/rules/storage-public-access" &&
      req.method === "GET"
    ) {
      return json(res, {
        success: true,
        rule: {
          rule_name: "storage-public-access",
          display_name: "Restrict public access",
          severity: "Warning",
          category: "security",
        },
      });
    }
    if (url.pathname === "/api/v1/billing/config") {
      return json(res, { plans: [{ id: "free", name: "Free", price_usd: 0 }] });
    }
    if (url.pathname === "/api/v1/billing/entitlement") {
      return json(res, {
        data: {
          plan: { id: "free", name: "Free", price_usd: 0 },
          balance: {
            credits_total: 150,
            credits_used: 10,
            credits_remaining: 140,
          },
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
      return json(res, {
        items: [{ id: "usage-1", credits: 1 }],
        next_cursor: null,
      });
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
    if (
      url.pathname === "/api/v1/billing/checkout/session/top-up" &&
      req.method === "POST"
    ) {
      return json(res, {
        session_id: "cs_topup_1",
        flow_type: "top_up",
        status: "created",
        expires_at: "2026-05-04T03:00:00",
        checkout_mode: "standard_checkout",
        checkout_url: null,
        launcher_url:
          "https://app.example.test/app/subscription/checkout-launcher?session_id=cs_topup_1",
        resolved_currency: "USD",
        display_amount_major: 9,
        payment_methods: { card: true },
      });
    }
    if (url.pathname === "/api/v1/billing/notifications") {
      return json(res, {
        notifications: [{ id: "note-1", type: "credit_low" }],
      });
    }
    if (url.pathname === "/api/v1/chat/stream" && req.method === "POST") {
      const payload = JSON.parse(body || "{}");
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      res.write(
        `data: ${JSON.stringify({ type: "metadata", thread_id: "thread-test", trace_id: "trace-test" })}\n\n`,
      );
      const message = String(payload.message ?? "");
      if (message.includes("empty agent result")) {
        res.write(
          `data: ${JSON.stringify({ type: "thinking", node: "load_reports", status: "streaming", description: "Loading cost reports" })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ type: "thinking", node: "load_reports", status: "completed", description: "Loaded cost reports" })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ type: "thinking", node: "end", status: "completed", description: "Finished without answer content" })}\n\n`,
        );
      } else if (
        message.includes("thinking progress") ||
        message.includes("Review ARM/Bicep template cost risk.")
      ) {
        res.write(
          `data: ${JSON.stringify({ type: "thinking", node: "load_reports", status: "streaming", description: "Loading cost reports" })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ type: "thinking", node: "load_reports", status: "completed", description: "Loaded cost reports" })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ type: "responding", node: "response_compose", content: "Report summary ready.", status: "completed" })}\n\n`,
        );
      } else if (message.includes("hitl approval")) {
        res.write(
          `data: ${JSON.stringify({ type: "thinking", node: "prepare_response", status: "streaming", description: "Prepare response" })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            type: "hitl_request",
            questions: [
              {
                id: "approval_0",
                text: "Should I proceed with running Regenerate cost report?",
                options: [
                  { id: "approve", label: "Approve", recommended: true },
                  { id: "reject", label: "Reject" },
                ],
                recommended_option_id: "approve",
              },
            ],
            checkpoint_id: "ckpt-cost-1",
            pending_intent_id: "approval_0",
            run_id: "run-cost-1",
            langsmith_trace_id: "trace-cost-1",
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ type: "thinking", node: "end", status: "completed", description: "Waiting for approval" })}\n\n`,
        );
      } else if (message.includes("duplicate chunks")) {
        res.write(
          `data: ${JSON.stringify({ type: "responding", node: "generate_response", content: "Mock duplicate answer." })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ type: "responding", node: "generate_response", content: "Mock duplicate answer." })}\n\n`,
        );
      } else {
        res.write(
          `data: ${JSON.stringify({ type: "responding", node: "generate_response", content: "Mock answer from Cloudeval AI." })}\n\n`,
        );
      }
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    return json(
      res,
      { detail: `Unhandled ${req.method} ${url.pathname}` },
      404,
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};

const cliInvocation = () => {
  const explicit = process.env.CLOUDEVAL_CLI_BIN;
  if (explicit) {
    return { command: path.resolve(explicit), prefix: [] as string[] };
  }
  return {
    command: path.resolve("node_modules/.bin/tsx"),
    prefix: [path.resolve("src/cli.tsx")],
  };
};

const runCli = async (
  args: string[],
  options: {
    input?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    home?: string;
    cwd?: string;
  } = {},
) => {
  const home =
    options.home ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-cli-test-home-")));
  const { command, prefix } = cliInvocation();
  const child = spawn(command, [...prefix, ...args], {
    cwd: options.cwd ?? path.resolve("."),
    env: {
      ...process.env,
      HOME: home,
      CI: "true",
      CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE: "1",
      CLOUDEVAL_HEADLESS_LOGIN: "1",
      CLOUDEVAL_ACCESS_KEY: "",
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

  const timeout = setTimeout(
    () => child.kill("SIGKILL"),
    options.timeoutMs ?? 20_000,
  );
  const exitCode = await new Promise<number | null>((resolve) =>
    child.on("exit", resolve),
  );
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

const bumpPatchVersion = (version: string): string => {
  const [major = "0", minor = "0", patch = "0"] = version
    .replace(/^v/i, "")
    .split(".");
  return `${Number(major)}.${Number(minor)}.${Number(patch.split("-")[0]) + 1}`;
};

const startUpdateServer = async (latestVersion: string) => {
  const requests: string[] = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(url.pathname);
    if (url.pathname === "/latest") {
      return json(res, {
        tag_name: `v${latestVersion}`,
        html_url: `https://example.test/releases/v${latestVersion}`,
        published_at: "2026-05-05T00:00:00.000Z",
      });
    }
    if (url.pathname === "/install.sh") {
      res.writeHead(200, { "Content-Type": "text/x-shellscript" });
      return res.end(
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'printf \'%s\\n\' "$1" > "$CLOUDEVAL_UPDATE_TEST_MARKER"',
          "",
        ].join("\n"),
      );
    }
    return json(
      res,
      { detail: `Unhandled ${req.method} ${url.pathname}` },
      404,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};

test("non-interactive discovery commands are machine-readable", async () => {
  const capabilities = parseJson(
    await runCli(["capabilities", "--format", "json"]),
  );
  assert.equal(capabilities.ok, true);
  assert.deepEqual(
    [
      "ask",
      "agent",
      "recipes run",
      "reports download",
      "projects create",
      "projects graph insights",
      "validate template",
      "rules search",
      "credentials create",
      "mcp serve",
    ].every((command) =>
      JSON.stringify(capabilities.data.domains).includes(command),
    ),
    true,
  );

  const completion = await runCli(["completion", "zsh"]);
  assert.equal(completion.exitCode, 0, completion.stderr);
  assert.match(completion.stdout, /_cloudeval/);

  const powershellCompletion = await runCli(["completion", "powershell"]);
  assert.equal(powershellCompletion.exitCode, 0, powershellCompletion.stderr);
  assert.match(powershellCompletion.stdout, /Register-ArgumentCompleter/);

  const dynamicCompletion = await runCli(["__complete", "compl"]);
  assert.equal(dynamicCompletion.exitCode, 0, dynamicCompletion.stderr);
  assert.match(dynamicCompletion.stdout, /^completion\tcommand\t/m);
});

test("recipes commands list, show, and run implemented CloudEval workflows", async () => {
  const backend = await startBackend();
  try {
    const table = await runCli(["recipes", "list"]);
    assert.equal(table.exitCode, 0, table.stderr);
    assert.match(table.stdout, /^ID\s+Title\s+Mode\s+Category\s+Safety/m);
    assert.match(table.stdout, /cloudeval-cloud-cost-review/);
    assert.doesNotMatch(table.stdout.toLowerCase(), /terraform/);

    const listed = parseJson(
      await runCli(["recipes", "list", "--format", "json"]),
    );
    assert.equal(listed.command, "recipes list");
    assert.equal(
      listed.data.recipes.some(
        (recipe: any) =>
          recipe.id === "cloudeval-well-architected-framework-review",
      ),
      true,
    );

    const shown = await runCli([
      "recipes",
      "show",
      "cloudeval-cloud-cost-review",
      "--format",
      "markdown",
    ]);
    assert.equal(shown.exitCode, 0, shown.stderr);
    assert.match(shown.stdout, /^# Cost Review/m);
    assert.match(shown.stdout, /cloudeval reports list --project/);

    const run = parseJson(
      await runCli([
        "recipes",
        "run",
        "cloudeval-cloud-cost-review",
        "--base-url",
        backend.baseUrl,
        "--access-key",
        "test-token",
        "--project",
        "project-main",
        "--format",
        "json",
        "--progress",
        "none",
        "--non-interactive",
      ]),
    );
    assert.equal(run.command, "recipes run");
    assert.equal(run.data.recipeId, "cloudeval-cloud-cost-review");
    assert.equal(run.data.mode, "ask");
    assert.equal(run.data.response, "Mock answer from Cloudeval AI.");

    const streamRequest = backend.requests.find(
      (request) => request.path === "/api/v1/chat/stream",
    );
    assert(streamRequest);
    const payload = JSON.parse(streamRequest.body);
    assert.match(payload.message, /CloudEval cost review/);
    assert.equal(payload.project.id, "project-main");
    assert.equal(payload.settings.mode, "ask");

    const missing = await runCli(["recipes", "show", "terraform-risk-scan"]);
    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr, /Unknown recipe 'terraform-risk-scan'/);
  } finally {
    await backend.close();
  }
});

test("credentials, identity, and live capabilities commands call credential APIs", async () => {
  const backend = await startBackend();
  try {
    const common = [
      "--base-url",
      backend.baseUrl,
      "--access-key",
      "test-token",
      "--format",
      "json",
      "--non-interactive",
    ];

    const templates = parseJson(
      await runCli(["credentials", "templates", ...common]),
    );
    assert.equal(templates.command, "credentials templates");
    assert.equal(templates.data.templates[0].id, "ci");

    const created = await runCli([
      "credentials",
      "create",
      "--base-url",
      backend.baseUrl,
      "--access-key",
      "test-token",
      "--template",
      "ci",
      "--name",
      "github-actions-prod",
      "--project",
      "project-main",
      "--expires",
      "90d",
      "--idempotency-key",
      "idem-create-1",
      "--format",
      "github-actions",
      "--non-interactive",
    ]);
    assert.equal(created.exitCode, 0, created.stderr);
    assert.match(
      created.stdout,
      /^CLOUDEVAL_ACCESS_KEY: cev_test_ak_01JTEST_createdsecret/m,
    );
    assert.match(created.stdout, /^CLOUDEVAL_PROJECT_ID: project-main/m);

    const outputDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudeval-credential-output-"),
    );
    const githubActionsOutput = path.join(outputDir, "github-actions.yml");
    const jsonOutput = path.join(outputDir, "credential.json");
    try {
      await fs.writeFile(githubActionsOutput, "old\n", { mode: 0o644 });
      await fs.chmod(githubActionsOutput, 0o644);
      const written = await runCli([
        "credentials",
        "create",
        "--base-url",
        backend.baseUrl,
        "--access-key",
        "test-token",
        "--template",
        "ci",
        "--name",
        "github-actions-prod",
        "--project",
        "project-main",
        "--expires",
        "90d",
        "--idempotency-key",
        "idem-create-1",
        "--format",
        "github-actions",
        "--output",
        githubActionsOutput,
        "--non-interactive",
      ]);
      assert.equal(written.exitCode, 0, written.stderr);
      assert.match(
        await fs.readFile(githubActionsOutput, "utf8"),
        /^CLOUDEVAL_ACCESS_KEY: cev_test_ak_01JTEST_createdsecret/m,
      );
      if (process.platform !== "win32") {
        assert.equal((await fs.stat(githubActionsOutput)).mode & 0o777, 0o600);
      }

      await fs.writeFile(jsonOutput, "old\n", { mode: 0o644 });
      await fs.chmod(jsonOutput, 0o644);
      const jsonWritten = await runCli([
        "credentials",
        "create",
        "--base-url",
        backend.baseUrl,
        "--access-key",
        "test-token",
        "--template",
        "ci",
        "--name",
        "github-actions-prod",
        "--project",
        "project-main",
        "--expires",
        "90d",
        "--idempotency-key",
        "idem-create-1",
        "--format",
        "json",
        "--output",
        jsonOutput,
        "--non-interactive",
      ]);
      assert.equal(jsonWritten.exitCode, 0, jsonWritten.stderr);
      assert.match(
        await fs.readFile(jsonOutput, "utf8"),
        /cev_test_ak_01JTEST_createdsecret/,
      );
      if (process.platform !== "win32") {
        assert.equal((await fs.stat(jsonOutput)).mode & 0o777, 0o600);
      }
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }

    const list = parseJson(
      await runCli([
        "credentials",
        "list",
        ...common,
        "--project",
        "project-main",
      ]),
    );
    assert.equal(list.command, "credentials list");
    assert.equal(list.data.credentials[0].key_prefix, "cev_test_ak_01JTEST");
    assert.equal(
      JSON.stringify(list.data),
      JSON.stringify(list.data).replace("createdsecret", ""),
    );

    const inspected = parseJson(
      await runCli(["credentials", "inspect", "cred-main", ...common]),
    );
    assert.equal(inspected.data.credential.id, "cred-main");
    assert.equal(inspected.data.audit_events[0].event_type, "credential.used");

    const revoked = parseJson(
      await runCli([
        "credentials",
        "revoke",
        "cred-main",
        "--base-url",
        backend.baseUrl,
        "--access-key",
        "test-token",
        "--reason",
        "rotated",
        "--idempotency-key",
        "idem-revoke-1",
        "--format",
        "json",
        "--non-interactive",
      ]),
    );
    assert.equal(revoked.data.credential.status, "revoked");

    const identity = parseJson(await runCli(["identity", ...common]));
    assert.equal(identity.command, "identity");
    assert.equal(identity.data.identity.email, user.email);
    assert.equal(
      identity.data.capabilities.includes("credentials:manage"),
      true,
    );

    const liveCapabilities = parseJson(
      await runCli(["capabilities", "--live", ...common]),
    );
    assert.equal(liveCapabilities.command, "capabilities");
    assert.equal(liveCapabilities.data.live.current_identity.email, user.email);
    assert.equal(
      liveCapabilities.data.live.allowed_tools[0].name,
      "reports.run",
    );
  } finally {
    await backend.close();
  }
});

test("legacy API key flags and environment variables fail with beta migration message", async () => {
  const flag = await runCli([
    "projects",
    "list",
    "--api-key",
    "old-token",
    "--non-interactive",
  ]);
  assert.notEqual(flag.exitCode, 0);
  assert.match(
    flag.stderr,
    /API key auth was renamed in beta\. Use --access-key or CLOUDEVAL_ACCESS_KEY\./,
  );

  const stdinFlag = await runCli(
    ["projects", "list", "--api-key-stdin", "--non-interactive"],
    {
      input: "old-token\n",
    },
  );
  assert.notEqual(stdinFlag.exitCode, 0);
  assert.match(
    stdinFlag.stderr,
    /API key auth was renamed in beta\. Use --access-key or CLOUDEVAL_ACCESS_KEY\./,
  );

  const envResult = await runCli(["status", "--format", "json"], {
    env: { CLOUDEVAL_API_KEY: "old-token" },
  });
  assert.notEqual(envResult.exitCode, 0);
  assert.match(
    envResult.stderr,
    /API key auth was renamed in beta\. Use --access-key or CLOUDEVAL_ACCESS_KEY\./,
  );
});

test("explicit --access-key warns without echoing the secret", async () => {
  const backend = await startBackend();
  try {
    const result = await runCli([
      "projects",
      "list",
      "--base-url",
      backend.baseUrl,
      "--access-key",
      "test-token",
      "--format",
      "json",
      "--non-interactive",
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(
      result.stderr,
      /--access-key can leak via shell history\/process listing/,
    );
    assert.doesNotMatch(result.stderr, /test-token/);

    const stdinResult = await runCli(
      [
        "projects",
        "list",
        "--base-url",
        backend.baseUrl,
        "--access-key-stdin",
        "--format",
        "json",
        "--non-interactive",
      ],
      { input: "test-token\n" },
    );
    assert.equal(stdinResult.exitCode, 0, stdinResult.stderr);
    assert.equal(stdinResult.stderr, "");
  } finally {
    await backend.close();
  }
});

test("completion install and uninstall manages shell script path", async () => {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudeval-cli-completion-home-"),
  );
  try {
    const install = await runCli(["completion", "install", "--shell", "bash"], {
      home,
    });
    assert.equal(install.exitCode, 0, install.stderr);
    assert.match(install.stdout, /Installed bash completion/);
    const installedPath = path.join(
      home,
      ".local",
      "share",
      "bash-completion",
      "completions",
      "cloudeval",
    );
    assert.match(
      await fs.readFile(installedPath, "utf8"),
      /_cloudeval_completion/,
    );

    const uninstall = await runCli(
      ["completion", "uninstall", "--shell", "bash"],
      { home },
    );
    assert.equal(uninstall.exitCode, 0, uninstall.stderr);
    assert.match(uninstall.stdout, /Removed bash completion/);
    await assert.rejects(fs.readFile(installedPath, "utf8"), /ENOENT/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("update command text output is a human summary, not a field/value table", async () => {
  const server = await startUpdateServer(CLI_VERSION);
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudeval-cli-update-home-"),
  );
  try {
    const result = await runCli(["update"], {
      home,
      env: {
        CLOUDEVAL_UPDATE_CHECK_URL: `${server.baseUrl}/latest`,
      },
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /^CloudEval CLI Update\n/);
    assert.match(result.stdout, /Status: up to date/);
    assert.doesNotMatch(result.stdout, /^Field\s+Value/m);
    assert.doesNotMatch(result.stdout, /^-+\s+-+/m);
    assert.deepEqual(server.requests, ["/latest"]);
  } finally {
    await server.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("update command checks and installs latest release non-interactively", async () => {
  const latestVersion = bumpPatchVersion(CLI_VERSION);
  const server = await startUpdateServer(latestVersion);
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudeval-cli-update-home-"),
  );
  const marker = path.join(home, "updated-version.txt");
  const env = {
    CLOUDEVAL_UPDATE_CHECK_URL: `${server.baseUrl}/latest`,
    CLOUDEVAL_UPDATE_INSTALLER_URL: `${server.baseUrl}/install.sh`,
    CLOUDEVAL_UPDATE_TEST_MARKER: marker,
  };

  try {
    const check = parseJson(
      await runCli(["update", "--check", "--format", "json"], { home, env }),
    );
    assert.equal(check.data.action, "available");
    assert.equal(check.data.currentVersion, CLI_VERSION);
    assert.equal(check.data.latestVersion, latestVersion);
    assert.equal(check.data.updateAvailable, true);
    await assert.rejects(fs.readFile(marker, "utf8"), /ENOENT/);

    const updated = parseJson(
      await runCli(["update", "--yes", "--format", "json"], { home, env }),
    );
    assert.equal(updated.data.action, "updated");
    assert.equal(updated.data.latestTag, `v${latestVersion}`);
    assert.equal(
      (await fs.readFile(marker, "utf8")).trim(),
      `v${latestVersion}`,
    );
    assert.deepEqual(server.requests, ["/latest", "/latest", "/install.sh"]);
  } finally {
    await server.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("phase one and two local commands are agent-safe and profile-aware", async () => {
  const backend = await startBackend();
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudeval-cli-phase12-home-"),
  );
  try {
    const setup = parseJson(
      await runCli(
        [
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
          "--mode",
          "agent",
          "--profile",
          "agent",
          "--format",
          "json",
        ],
        { home },
      ),
    );
    assert.equal(setup.command, "setup");
    assert.equal(setup.data.config.baseUrl, backend.baseUrl);
    assert.equal(setup.data.config.defaultProjectId, "project-main");
    assert.equal(setup.data.config.mode, "agent");

    const config = parseJson(
      await runCli(
        ["config", "show", "--profile", "agent", "--format", "json"],
        { home },
      ),
    );
    assert.equal(config.command, "config show");
    assert.equal(config.data.baseUrl, backend.baseUrl);
    assert.equal(config.data.model, "gpt-5-mini");
    assert.equal(config.data.mode, "agent");

    const modeDefault = parseJson(
      await runCli(
        ["config", "get", "mode", "--profile", "agent", "--format", "json"],
        { home },
      ),
    );
    assert.equal(modeDefault.data.value, "agent");

    const configPath = await runCli(["config", "path", "--profile", "agent"], {
      home,
    });
    assert.equal(configPath.exitCode, 0, configPath.stderr);
    assert.match(configPath.stdout, /settings\.json/);

    const modelDefault = parseJson(
      await runCli(
        ["models", "default", "get", "--profile", "agent", "--format", "json"],
        { home },
      ),
    );
    assert.equal(modelDefault.data.model, "gpt-5-mini");

    const models = parseJson(
      await runCli(
        [
          "models",
          "list",
          "--access-key",
          "test-token",
          "--profile",
          "agent",
          "--format",
          "json",
        ],
        { home },
      ),
    );
    assert.equal(models.command, "models list");
    assert.equal(models.data.models[1].id, "gpt-5-mini");

    const status = parseJson(
      await runCli(["status", "--profile", "agent", "--format", "json"], {
        home,
      }),
    );
    assert.equal(status.command, "status");
    assert.equal(status.data.baseUrl, backend.baseUrl);
    assert.equal(status.data.auth.authenticated, false);

    const doctor = parseJson(
      await runCli(["doctor", "--profile", "agent", "--format", "json"], {
        home,
      }),
    );
    assert.equal(doctor.command, "doctor");
    assert.equal(doctor.data.ok, true);
    assert.equal(
      doctor.data.checks.some((check: any) => check.id === "base-url-secure"),
      true,
    );

    const mcpDoctor = parseJson(
      await runCli(
        ["doctor", "--profile", "agent", "--mcp", "--format", "json"],
        { home },
      ),
    );
    assert.equal(mcpDoctor.command, "doctor");
    assert.equal(mcpDoctor.data.ok, true);
    assert.equal(
      mcpDoctor.data.checks.some((check: any) => check.id === "mcp-tools-list"),
      true,
    );
    assert.equal(mcpDoctor.data.mcp.toolsets.includes("readonly"), true);

    const capabilities = parseJson(
      await runCli(["capabilities", "--format", "json"], { home }),
    );
    assert.equal(
      JSON.stringify(capabilities.data.domains).includes("doctor"),
      true,
    );
    assert.equal(
      JSON.stringify(capabilities.data.domains).includes("sessions list"),
      true,
    );
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
  assert.equal(
    status.data.resources.includes("cloudeval://capabilities"),
    true,
  );
  assert.equal(
    status.data.prompts.includes("cloudeval-cloud-cost-review"),
    true,
  );
  assert.equal(status.data.setupClients.includes("generic"), true);
  assert.equal(status.data.setupClients.includes("vscode"), true);

  const setup = parseJson(
    await runCli([
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
    ]),
  );
  assert.equal(setup.command, "mcp setup");
  assert.equal(setup.data.client, "codex");
  assert.deepEqual(setup.data.server.args, [
    "mcp",
    "serve",
    "--toolset",
    "readonly",
  ]);
  assert.match(setup.data.instructions[0], /codex mcp add cloudeval/);

  const genericSetup = parseJson(
    await runCli([
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
    ]),
  );
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
  assert.match(
    genericSetup.data.instructions[0],
    /Copy the shown mcpServers\.cloudeval entry/,
  );

  const vscodeHome = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudeval-cli-vscode-mcp-home-"),
  );
  try {
    const vscodeSetup = parseJson(
      await runCli(
        [
          "mcp",
          "setup",
          "vscode",
          "--dry-run",
          "--command",
          "/usr/local/bin/cloudeval",
          "--toolset",
          "readonly",
          "--format",
          "json",
        ],
        { home: vscodeHome, cwd: vscodeHome },
      ),
    );
    assert.equal(vscodeSetup.command, "mcp setup");
    assert.equal(vscodeSetup.data.client, "vscode");
    assert.match(vscodeSetup.data.configPath, /\.vscode\/mcp\.json$/);
    assert.deepEqual(vscodeSetup.data.config, {
      servers: {
        cloudeval: {
          type: "stdio",
          command: "/usr/local/bin/cloudeval",
          args: ["mcp", "serve", "--toolset", "readonly"],
        },
      },
    });
    assert.match(vscodeSetup.data.instructions[0], /VS Code/);
    assert.match(vscodeSetup.data.instructions[1], /"type":"stdio"/);
  } finally {
    await fs.rm(vscodeHome, { recursive: true, force: true });
  }
});

test("mcp setup human output is readable and avoids generic field tables", async () => {
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudeval-cli-mcp-human-home-"),
  );
  try {
    const result = await runCli(
      [
        "mcp",
        "setup",
        "claude",
        "--command",
        "/usr/local/bin/cloudeval",
        "--toolset",
        "readonly",
      ],
      { home },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /^CloudEval MCP setup\n/);
    assert.match(result.stdout, /Client: Claude/);
    assert.match(result.stdout, /Status: wrote config/);
    assert.match(
      result.stdout,
      /Command: \/usr\/local\/bin\/cloudeval mcp serve --toolset readonly/,
    );
    assert.match(
      result.stdout,
      /Restart Claude Desktop to load the CloudEval MCP server/,
    );
    assert.doesNotMatch(result.stdout, /Merge the shown/);
    assert.doesNotMatch(result.stdout, /^Field\s+Value/m);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("auth status is non-interactive and respects explicit base url", async () => {
  const backend = await startBackend();
  try {
    const result = await runCli([
      "auth",
      "status",
      "--base-url",
      backend.baseUrl,
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /^Field\s+Value/m);
    assert.match(result.stdout, /^Authenticated\s+no$/m);
    assert.match(
      result.stdout,
      new RegExp(
        `^CLI API URL\\s+${backend.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "m",
      ),
    );
  } finally {
    await backend.close();
  }
});

test("auth status redacts stored account and session ids unless explicitly requested", async () => {
  const backend = await startBackend();
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudeval-cli-auth-status-home-"),
  );
  const configDir = path.join(home, ".config", "cloudeval");
  const sessionId = "63da1973-e92a-4d2e-8d01-4d8e131b3f21";
  const accountId = "5ed935a4-0814-4099-8b10-f6ef9ea74ff4";

  try {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          tokenRef: "access-token",
          tokenExpiresAt: Date.now() + 3_600_000,
          baseUrl: backend.baseUrl,
          sessionId,
          accountId,
        },
        null,
        2,
      ),
    );
    await fs.writeFile(
      path.join(configDir, "secrets.json"),
      JSON.stringify({ "access-token": "test-token" }, null, 2),
    );

    const textResult = await runCli(
      ["auth", "status", "--base-url", backend.baseUrl],
      { home },
    );
    assert.equal(textResult.exitCode, 0, textResult.stderr);
    assert.doesNotMatch(textResult.stdout, new RegExp(sessionId));
    assert.doesNotMatch(textResult.stdout, new RegExp(accountId));
    assert.match(textResult.stdout, /^Session ID\s+63da\.\.\.3f21$/m);
    assert.match(textResult.stdout, /^Account ID\s+5ed9\.\.\.4ff4$/m);

    const jsonResult = parseJson(
      await runCli(
        ["auth", "status", "--base-url", backend.baseUrl, "--format", "json"],
        { home },
      ),
    );
    assert.equal(jsonResult.data.sessionId, "63da...3f21");
    assert.equal(jsonResult.data.accountId, "5ed9...4ff4");

    const fullJsonResult = parseJson(
      await runCli(
        [
          "auth",
          "status",
          "--base-url",
          backend.baseUrl,
          "--format",
          "json",
          "--show-sensitive-ids",
        ],
        { home },
      ),
    );
    assert.equal(fullJsonResult.data.sessionId, sessionId);
    assert.equal(fullJsonResult.data.accountId, accountId);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await backend.close();
  }
});

test("status human output is a readable summary instead of formatter tables", async () => {
  const backend = await startBackend();
  try {
    const result = await runCli(["status", "--base-url", backend.baseUrl]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /^CloudEval CLI Status$/m);
    assert.match(result.stdout, /^Profile:\s+default$/m);
    assert.match(
      result.stdout,
      new RegExp(
        `^Base URL:\\s+${backend.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "m",
      ),
    );
    assert.match(result.stdout, /^Auth:\s+(signed in|signed out)$/m);
    assert.doesNotMatch(result.stdout, /^Field\s+Value$/m);
    assert.doesNotMatch(result.stdout, /^-+\s+-+$/m);
  } finally {
    await backend.close();
  }
});

test("auth-gated project commands clear backend-rejected stored auth", async () => {
  const backend = await startBackend({ authMeStatus: 401 });
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudeval-cli-rejected-auth-"),
  );
  const configDir = path.join(home, ".config", "cloudeval");
  const configPath = path.join(configDir, "config.json");
  const secretsPath = path.join(configDir, "secrets.json");

  try {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          tokenRef: "access-token",
          tokenExpiresAt: Date.now() + 3_600_000,
          baseUrl: backend.baseUrl,
        },
        null,
        2,
      ),
    );
    await fs.writeFile(
      secretsPath,
      JSON.stringify(
        {
          "access-token": "backend-rejected-token",
        },
        null,
        2,
      ),
    );

    const result = await runCli(
      [
        "projects",
        "list",
        "--base-url",
        backend.baseUrl,
        "--format",
        "json",
        "--non-interactive",
      ],
      { home },
    );

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /Run `cloudeval login` and retry/);
    assert.match(
      result.stderr,
      /Stored authentication was rejected by CloudEval/,
    );
    await assert.rejects(fs.stat(configPath), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await fs.readFile(secretsPath, "utf8")), {});
  } finally {
    await backend.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("headless login runs quick Playground onboarding for device-created users", async () => {
  const incompleteUser = {
    ...user,
    preferences: {},
  } as typeof user;
  const backend = await startBackend({
    authUser: incompleteUser,
    projects: [],
  });
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudeval-cli-login-home-"),
  );

  try {
    const result = await runCli(
      ["login", "--base-url", backend.baseUrl, "--headless"],
      { home, timeoutMs: 15_000 },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Authentication successful\. Session saved\./);
    assert.match(result.stdout, /Setting up your Playground project/);
    assert.match(result.stdout, /Playground project ready/);
    assert.match(result.stdout, /Login successful/);

    const quickRequest = backend.requests.find(
      (request) => request.path === "/api/v1/onboard/quick",
    );
    assert.ok(
      quickRequest,
      "login should call /onboard/quick after device auth",
    );
    assert.equal(quickRequest.authorization, "Bearer test-token");
    const body = JSON.parse(quickRequest.body || "{}");
    assert.equal(body.email, user.email);
    assert.equal(body.full_name, user.full_name);
  } finally {
    await backend.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("project creation, project reads, output files, and stdin access key work non-interactively", async () => {
  const backend = await startBackend();
  const outputDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudeval-project-output-"),
  );
  try {
    const create = parseJson(
      await runCli([
        "projects",
        "create",
        "--base-url",
        backend.baseUrl,
        "--access-key",
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
      ]),
    );
    assert.equal(create.command, "projects create");
    assert.equal(create.data.project.id, "project-created");
    assert.equal(create.data.connection.id, "conn-created");
    assert.match(
      create.frontendUrl,
      /https:\/\/app\.example\.test\/app\/projects\/project-created/,
    );

    const list = await runCli(
      [
        "projects",
        "list",
        "--base-url",
        backend.baseUrl,
        "--access-key-stdin",
        "--format",
        "ndjson",
        "--non-interactive",
      ],
      { input: "stdin-token\n" },
    );
    assert.equal(list.exitCode, 0, list.stderr);
    assert.match(list.stdout, /"id":"project-main"/);

    const textList = await runCli([
      "projects",
      "list",
      "--base-url",
      backend.baseUrl,
      "--access-key",
      "test-token",
      "--format",
      "text",
      "--non-interactive",
    ]);
    assert.equal(textList.exitCode, 0, textList.stderr);
    assert.match(
      textList.stdout,
      /^ID\s+Name\s+Provider\s+Source\s+Status\s+Updated/m,
    );
    assert.match(textList.stdout, /project-main\s+Playground\s+azure/);
    assert.doesNotMatch(textList.stdout, /dashboard:/);
    assert.doesNotMatch(textList.stdout, /reports:/);

    const serviceList = parseJson(
      await runCli([
        "projects",
        "list",
        "--base-url",
        backend.baseUrl,
        "--access-key",
        "cev_test_ak_01JSERVICE_secret",
        "--format",
        "json",
        "--non-interactive",
      ]),
    );
    assert.equal(serviceList.command, "projects list");
    assert.equal(serviceList.data[0].id, "project-main");
    assert.ok(
      backend.requests.some(
        (request) =>
          request.path === "/api/v1/projects/" &&
          request.authorization === "Bearer cev_test_ak_01JSERVICE_secret",
      ),
      "service-account access keys should list projects through the scoped collection endpoint",
    );

    const output = path.join(outputDir, "project.json");
    const get = await runCli([
      "projects",
      "get",
      "project-main",
      "--base-url",
      backend.baseUrl,
      "--access-key",
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

    const serviceGet = parseJson(
      await runCli([
        "projects",
        "get",
        "project-main",
        "--base-url",
        backend.baseUrl,
        "--access-key",
        "cev_test_ak_01JSERVICE_secret",
        "--format",
        "json",
        "--non-interactive",
      ]),
    );
    assert.equal(serviceGet.command, "projects get");
    assert.equal(serviceGet.data.id, "project-main");

    const frontendUrl = new URL(backend.baseUrl).origin;
    const imageOutput = path.join(outputDir, "architecture.png");
    const headersOutput = path.join(outputDir, "architecture.headers");
    const relativeImageOutput = path.relative(path.resolve("."), imageOutput);
    const relativeHeadersOutput = path.relative(
      path.resolve("."),
      headersOutput,
    );
    const image = await runCli([
      "projects",
      "export-diagram",
      "project-main",
      "--base-url",
      backend.baseUrl,
      "--frontend-url",
      frontendUrl,
      "--access-key",
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
      new RegExp(
        `Downloaded architecture diagram to ${imageOutput.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
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
      (request) =>
        request.path === "/api/projects/missing-project/diagram-image",
    ).length;
    const missingImage = await runCli([
      "projects",
      "export-diagram",
      "missing-project",
      "--base-url",
      backend.baseUrl,
      "--frontend-url",
      frontendUrl,
      "--access-key",
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
        (request) =>
          request.path === "/api/projects/missing-project/diagram-image",
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
    assert.equal(
      await fs.readFile(publicImageOutput, "utf8"),
      "<svg>mock</svg>",
    );
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
    assert.equal(
      await fs.readFile(legacyImageOutput, "utf8"),
      "mock-image-bytes",
    );
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
    await backend.close();
  }
});

test("project graph commands expose graph intelligence for automation", async () => {
  const backend = await startBackend();
  const common = [
    "--base-url",
    backend.baseUrl,
    "--access-key",
    "test-token",
    "--format",
    "json",
    "--non-interactive",
  ];
  try {
    const graph = parseJson(
      await runCli(["projects", "graph", "project-main", ...common]),
    );
    assert.equal(graph.command, "projects graph");
    assert.equal(graph.data.nodes[0].id, "vm-1");

    const syncRuns = parseJson(
      await runCli(["projects", "graph", "sync-runs", "project-main", ...common]),
    );
    assert.equal(syncRuns.command, "projects graph sync-runs");
    assert.equal(syncRuns.data.active_sync_version, "sync-2");

    const diff = parseJson(
      await runCli([
        "projects",
        "graph",
        "diff",
        "project-main",
        "--from",
        "sync-1",
        "--to",
        "sync-2",
        ...common,
      ]),
    );
    assert.equal(diff.command, "projects graph diff");
    assert.deepEqual(diff.data.summary, { added: 1, removed: 0, changed: 2 });

    const insights = parseJson(
      await runCli([
        "projects",
        "graph",
        "insights",
        "project-main",
        "--focus",
        "impact",
        "--resource",
        "vm-1",
        ...common,
      ]),
    );
    assert.equal(insights.command, "projects graph insights");
    assert.equal(insights.data.insights[0].affected_resources, 3);
  } finally {
    await backend.close();
  }
});

test("template validation, parsing, and rule catalog commands use generic public names", async () => {
  const backend = await startBackend();
  const outputDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudeval-template-"),
  );
  const templatePath = path.join(outputDir, "template.json");
  const parametersPath = path.join(outputDir, "parameters.json");
  const common = [
    "--base-url",
    backend.baseUrl,
    "--access-key",
    "test-token",
    "--format",
    "json",
    "--non-interactive",
  ];
  try {
    await fs.writeFile(templatePath, JSON.stringify(templateFixture), "utf8");
    await fs.writeFile(parametersPath, JSON.stringify(parameterFileFixture), "utf8");

    const validationResult = await runCli([
        "validate",
        "template",
        "--template-file",
        templatePath,
        "--parameters-file",
        parametersPath,
        "--failed-only",
        "--min-severity",
        "Warning",
        "--rule",
        "storage-public-access",
        "--rule",
        "storage-encryption",
        ...common,
      ]);
    const validation = parseJson(validationResult);
    assert.equal(validation.command, "validate template");
    assert.equal(validation.data.summary.failed_rules, 2);
    assert.deepEqual(validation.data.requested_rule_names, [
      "storage-public-access",
      "storage-encryption",
    ]);

    const validationDetailsResult = await runCli([
      "validate",
      "template",
      "--template-file",
      templatePath,
      "--parameters-file",
      parametersPath,
      "--details",
      "--rule",
      "storage-public-access",
      ...common,
    ]);
    const validationDetails = parseJson(validationDetailsResult);
    assert.equal(validationDetails.command, "validate template");
    assert.equal(validationDetails.data.summary.failed_rules, 1);
    assert.equal(validationDetails.data.details.length, 1);
    assert.deepEqual(validationDetails.data.details[0], {
      source: "template_rules",
      rule_id: "storage-public-access",
      rule_name: "storage-public-access",
      display_name: "Disable anonymous blob access",
      status: "Fail",
      severity: "Warning",
      target: {
        name: "sttest001",
        type: "Microsoft.Storage/storageAccounts",
      },
      evidence: {
        description: "Storage accounts should reject anonymous blob access.",
        synopsis: "Anonymous blob access increases data exposure risk.",
        recommendation: "Set allowBlobPublicAccess to false.",
        documentation_url: "https://example.test/rules/storage-public-access",
      },
    });

    const waitedValidationResult = await runCli([
      "validate",
      "template",
      "--template-file",
      templatePath,
      "--parameters-file",
      parametersPath,
      "--rule",
      "async-template-validation",
      "--wait",
      "--poll-interval",
      "10",
      "--wait-timeout",
      "5000",
      ...common,
    ]);
    const waitedValidation = parseJson(waitedValidationResult);
    assert.equal(waitedValidation.command, "validate template");
    assert.equal(waitedValidation.data.jobId, "job-template-validation-1");
    assert.equal(waitedValidation.data.status.status, "SUCCEEDED");
    assert.equal(waitedValidation.data.result.summary.failed_rules, 1);

    const templateTestsResult = await runCli([
      "validate",
      "tests",
      "--template-file",
      templatePath,
      "--parameters-file",
      parametersPath,
      "--test",
      "IDs Should Be Derived From ResourceIDs",
      "--wait",
      "--poll-interval",
      "10",
      "--wait-timeout",
      "5000",
      ...common,
    ]);
    const templateTests = parseJson(templateTestsResult);
    assert.equal(templateTests.command, "validate tests");
    assert.equal(templateTests.data.jobId, "job-template-tests-1");
    assert.equal(templateTests.data.status.status, "SUCCEEDED");
    assert.deepEqual(templateTests.data.summary, {
      total_tests: 2,
      passed_tests: 1,
      failed_tests: 1,
      skipped_tests: 0,
    });
    assert.equal(templateTests.data.details.length, 2);
    assert.deepEqual(templateTests.data.details[1], {
      source: "template_tests",
      test_name: "IDs Should Be Derived From ResourceIDs",
      category: "security",
      status: "Fail",
      passed: false,
      severity: "error",
      message: "One resource id is not derived from resourceId().",
      recommendation: "Use resourceId() for resource identifiers.",
      duration_ms: 18,
      file_path: "azuredeploy.json",
    });

    const validationWithoutParamsResult = await runCli([
      "validate",
      "template",
      "--template-file",
      templatePath,
      ...common,
    ]);
    const validationWithoutParams = parseJson(validationWithoutParamsResult);
    assert.equal(validationWithoutParams.command, "validate template");
    assert.equal(validationWithoutParams.data.summary.failed_rules, 2);

    const parseResult = await runCli([
        "validate",
        "parse",
        "--template-file",
        templatePath,
        ...common,
      ]);
    const parsed = parseJson(parseResult);
    assert.equal(parsed.command, "validate parse");
    assert.equal(parsed.data.resource_count, 1);

    const parseWithParamsResult = await runCli([
      "validate",
      "parse",
      "--template-file",
      templatePath,
      "--parameters-file",
      parametersPath,
      ...common,
    ]);
    const parsedWithParams = parseJson(parseWithParamsResult);
    assert.equal(parsedWithParams.command, "validate parse");
    assert.equal(parsedWithParams.data.resource_count, 1);

    const categories = parseJson(
      await runCli(["rules", "categories", ...common]),
    );
    assert.equal(categories.command, "rules categories");
    assert.equal(categories.data.categories.security.rule_count, 1);

    const search = parseJson(
      await runCli(["rules", "search", "public network", ...common]),
    );
    assert.equal(search.command, "rules search");
    assert.equal(search.data.results[0].rule_name, "storage-public-access");

    const show = parseJson(
      await runCli(["rules", "show", "storage-public-access", ...common]),
    );
    assert.equal(show.command, "rules show");
    assert.equal(show.data.rule.rule_name, "storage-public-access");

    const internalEngineLabels = [/P[S]Rule/i, /A[R]M TTK/i];
    for (const label of internalEngineLabels) {
      assert.doesNotMatch(validationResult.stdout, label);
      assert.doesNotMatch(parseResult.stdout, label);
    }
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
    await backend.close();
  }
});

test("connections and frontend deeplinks run without opening browsers", async () => {
  const backend = await startBackend();
  try {
    const list = parseJson(
      await runCli([
        "connections",
        "list",
        "--base-url",
        backend.baseUrl,
        "--access-key",
        "test-token",
        "--format",
        "json",
        "--non-interactive",
      ]),
    );
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
    assert.match(
      open.stdout,
      /https:\/\/app\.example\.test\/app\/projects\/project-main/,
    );
    assert.match(open.stdout, /view=both/);
    assert.match(open.stdout, /layout=dependency/);
  } finally {
    await backend.close();
  }
});

test("report list, show, cost, waf, rules, and download commands return report data", async () => {
  const backend = await startBackend();
  const outputDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudeval-report-output-"),
  );
  try {
    const common = [
      "--base-url",
      backend.baseUrl,
      "--access-key",
      "test-token",
      "--project",
      "project-main",
      "--non-interactive",
    ];

    const list = await runCli([
      "reports",
      "list",
      ...common,
      "--kind",
      "all",
      "--format",
      "json",
    ]);
    assert.equal(list.exitCode, 0, list.stderr);
    const listed = JSON.parse(list.stdout);
    assert.equal(listed.length, 2);
    assert.equal(listed[0].id, "cost-current");

    const shown = parseJson(
      await runCli([
        "reports",
        "show",
        "cost-current",
        ...common,
        "--format",
        "json",
        "--parsed",
      ]),
    );
    assert.equal(shown.totalSpend.amount, 42);

    const cost = await runCli([
      "reports",
      "cost",
      ...common,
      "--period",
      "30d",
      "--format",
      "markdown",
      "--formatted",
    ]);
    assert.equal(cost.exitCode, 0, cost.stderr);
    assert.match(cost.stdout, /# Cost Report/);

    const waf = await runCli([
      "reports",
      "waf",
      ...common,
      "--severity",
      "medium",
      "--format",
      "json",
      "--parsed",
    ]);
    assert.equal(waf.exitCode, 0, waf.stderr);
    assert.equal(JSON.parse(waf.stdout).score.overall, 91);

    const rules = parseJson(
      await runCli(["reports", "rules", ...common, "--format", "json"]),
    );
    assert.equal(rules.command, "reports rules");
    assert.equal(rules.data[0].id, "SEC-1");

    const run = parseJson(
      await runCli([
        "reports",
        "run",
        ...common,
        "--type",
        "cost",
        "--format",
        "json",
        "--no-open",
      ]),
    );
    assert.equal(run.command, "reports run");
    assert.equal(run.data.projectId, "project-main");
    assert.deepEqual(run.data.jobs, ["job-cost-1"]);

    const download = parseJson(
      await runCli([
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
      ]),
    );
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
    const common = [
      "--base-url",
      backend.baseUrl,
      "--access-key",
      "test-token",
      "--format",
      "json",
      "--non-interactive",
    ];
    const credits = parseJson(await runCli(["credits", ...common]));
    assert.equal(credits.command, "credits");
    assert.equal(credits.data.entitlement.plan.id, "free");

    const summary = parseJson(await runCli(["billing", "summary", ...common]));
    assert.equal(summary.data.subscriptionStatus.status, "active");

    const usage = parseJson(
      await runCli([
        "billing",
        "usage",
        ...common,
        "--range",
        "7d",
        "--granularity",
        "day",
      ]),
    );
    assert.equal(usage.data.total_events, 2);

    const ledger = parseJson(
      await runCli(["billing", "ledger", ...common, "--limit", "5"]),
    );
    assert.equal(ledger.data.items[0].id, "usage-1");

    const plans = parseJson(await runCli(["billing", "plans", ...common]));
    assert.equal(plans.data.plans[0].id, "free");

    const topups = parseJson(await runCli(["billing", "topups", ...common]));
    assert.equal(topups.data.packs[0].id, "starter");

    const checkout = parseJson(
      await runCli([
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
      ]),
    );
    assert.equal(checkout.command, "billing topup");
    assert.equal(checkout.data.packId, "starter");
    assert.equal(checkout.data.session.session_id, "cs_t...up_1");
    assert.equal(
      checkout.data.checkoutUrl,
      "https://app.example.test/app/subscription/checkout-launcher?session_id=cs_t...up_1",
    );

    const fullCheckout = parseJson(
      await runCli([
        "--show-sensitive-ids",
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
      ]),
    );
    assert.equal(fullCheckout.data.session.session_id, "cs_topup_1");
    assert.equal(
      fullCheckout.data.checkoutUrl,
      "https://app.example.test/app/subscription/checkout-launcher?session_id=cs_topup_1",
    );

    const checkoutRequest = backend.requests.find(
      (request) => request.path === "/api/v1/billing/checkout/session/top-up",
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

test("default human output uses tables for list-style authenticated commands", async () => {
  const backend = await startBackend();
  try {
    const common = [
      "--base-url",
      backend.baseUrl,
      "--access-key",
      "test-token",
      "--non-interactive",
    ];

    const reports = await runCli(["reports", "list", ...common]);
    assert.equal(reports.exitCode, 0, reports.stderr);
    assert.match(reports.stdout, /^ID\s+Kind\s+Project\s+Generated/m);
    assert.match(reports.stdout, /^--/m);

    const connections = await runCli(["connections", "list", ...common]);
    assert.equal(connections.exitCode, 0, connections.stderr);
    assert.match(connections.stdout, /^ID\s+Name\s+Provider\s+Type\s+Sync/m);
    assert.doesNotMatch(connections.stdout, /^id: /m);

    const models = await runCli(["models", "list", ...common]);
    assert.equal(models.exitCode, 0, models.stderr);
    assert.match(models.stdout, /^ID\s+Name\s+Provider\s+Availability/m);
    assert.doesNotMatch(models.stdout, /^models: \[/m);

    const plans = await runCli(["billing", "plans", ...common]);
    assert.equal(plans.exitCode, 0, plans.stderr);
    assert.match(plans.stdout, /^ID\s+Name\s+Price\s+Credits/m);
    assert.doesNotMatch(plans.stdout, /^plans: \[/m);

    const ledger = await runCli([
      "billing",
      "ledger",
      ...common,
      "--limit",
      "5",
    ]);
    assert.equal(ledger.exitCode, 0, ledger.stderr);
    assert.match(ledger.stdout, /^ID\s+Action\s+Outcome\s+Credits/m);
    assert.doesNotMatch(ledger.stdout, /^items: \[/m);
  } finally {
    await backend.close();
  }
});

test("agents list and show do not require authentication", async () => {
  const backend = await startBackend();
  try {
    const list = parseJson(
      await runCli([
        "agents",
        "list",
        "--base-url",
        backend.baseUrl,
        "--format",
        "json",
        "--non-interactive",
      ]),
    );
    assert.equal(list.data.profiles[0].display_name, "Cost");

    const show = parseJson(
      await runCli([
        "agents",
        "show",
        "cost",
        "--base-url",
        backend.baseUrl,
        "--format",
        "json",
        "--non-interactive",
      ]),
    );
    assert.equal(show.data.profile.id, "cost");

    const profileRequests = backend.requests.filter((request) =>
      request.path.startsWith("/api/v1/agent-profiles"),
    );
    assert.equal(profileRequests.length, 2);
    assert.deepEqual(
      profileRequests.map((request) => request.authorization),
      [undefined, undefined],
    );
  } finally {
    await backend.close();
  }
});

test("agents list and show fall back to bundled profiles when backend requires authentication", async () => {
  const backend = await startBackend({ agentProfilesStatus: 401 });
  try {
    const list = parseJson(
      await runCli([
        "agents",
        "list",
        "--base-url",
        backend.baseUrl,
        "--format",
        "json",
        "--non-interactive",
      ]),
    );
    assert.deepEqual(
      list.data.profiles.map((profile: any) => profile.id),
      ["architecture", "cost", "triage", "remediation"],
    );
    assert.equal(list.data.profiles[0].display_name, "Architecture");

    const show = parseJson(
      await runCli([
        "agents",
        "show",
        "remediation",
        "--base-url",
        backend.baseUrl,
        "--format",
        "json",
        "--non-interactive",
      ]),
    );
    assert.equal(show.data.profile.id, "remediation");
    assert.equal(show.data.profile.display_name, "Remediation");

    const profileRequests = backend.requests.filter((request) =>
      request.path.startsWith("/api/v1/agent-profiles"),
    );
    assert.equal(profileRequests.length, 2);
    assert.deepEqual(
      profileRequests.map((request) => request.authorization),
      [undefined, undefined],
    );
  } finally {
    await backend.close();
  }
});

test("agents list falls back to bundled profiles when backend catalog route is missing", async () => {
  const backend = await startBackend({ agentProfilesStatus: 404 });
  try {
    const list = parseJson(
      await runCli([
        "agents",
        "list",
        "--base-url",
        backend.baseUrl,
        "--format",
        "json",
        "--non-interactive",
      ]),
    );
    assert.deepEqual(
      list.data.profiles.map((profile: any) => profile.id),
      ["architecture", "cost", "triage", "remediation"],
    );
  } finally {
    await backend.close();
  }
});

test("agents run sends the selected Agent Profile to chat stream", async () => {
  const backend = await startBackend();
  try {
    const result = parseJson(
      await runCli([
        "agents",
        "run",
        "cost",
        "thinking progress",
        "--project",
        "project-main",
        "--base-url",
        backend.baseUrl,
        "--access-key",
        "test-token",
        "--format",
        "json",
        "--non-interactive",
      ]),
    );

    assert.equal(result.command, "agents run");
    assert.equal(result.data.profile.display_name, "Cost");
    assert.equal(result.data.response, "Report summary ready.");

    const streamRequest = backend.requests.find(
      (request) => request.path === "/api/v1/chat/stream",
    );
    assert(streamRequest);
    const payload = JSON.parse(streamRequest.body);
    assert.equal(payload.agent_profile_id, "cost");
    assert.equal(payload.input.agent_profile_id, "cost");
    assert.equal(payload.settings.mode, "agent");
    assert.equal(streamRequest.authorization, "Bearer test-token");
  } finally {
    await backend.close();
  }
});

test("agents run uses a project-type starter prompt when no prompt is passed", async () => {
  const backend = await startBackend();
  try {
    const result = parseJson(
      await runCli([
        "agents",
        "run",
        "cost",
        "--project",
        "project-main",
        "--base-url",
        backend.baseUrl,
        "--access-key",
        "test-token",
        "--format",
        "json",
        "--non-interactive",
      ]),
    );

    assert.equal(
      result.data.prompt,
      "Review template cost evidence and next validation step.",
    );

    const streamRequest = backend.requests.find(
      (request) => request.path === "/api/v1/chat/stream",
    );
    assert(streamRequest);
    const payload = JSON.parse(streamRequest.body);
    assert.equal(
      payload.message,
      "Review template cost evidence and next validation step.",
    );
  } finally {
    await backend.close();
  }
});

test("billing auth failures preserve JSON output", async () => {
  const plans = parseJsonError(
    await runCli(["billing", "plans", "--format", "json", "--non-interactive"]),
  );
  assert.equal(plans.ok, false);
  assert.equal(plans.command, "billing plans");
  assert.match(plans.error.message, /No authentication available/);

  const topups = parseJsonError(
    await runCli([
      "billing",
      "topups",
      "--format",
      "json",
      "--non-interactive",
    ]),
  );
  assert.equal(topups.ok, false);
  assert.equal(topups.command, "billing topups");
  assert.match(topups.error.message, /No authentication available/);
});

test("ask streams a single answer non-interactively with selected project and model", async () => {
  const backend = await startBackend();
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudeval-cli-session-home-"),
  );
  try {
    const answer = parseJson(
      await runCli(
        [
          "ask",
          "What can you do?",
          "--base-url",
          backend.baseUrl,
          "--access-key",
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
        ],
        { home },
      ),
    );
    assert.equal(answer.command, "ask");
    assert.equal(answer.data.response, "Mock answer from Cloudeval AI.");
    assert.equal(answer.data.project.id, "project-main");

    const sessions = parseJson(
      await runCli(["sessions", "list", "--format", "json"], { home }),
    );
    assert.equal(sessions.command, "sessions list");
    assert.equal(sessions.data[0].threadId, answer.data.threadId);
    assert.equal(sessions.data[0].projectId, "project-main");

    const session = parseJson(
      await runCli(
        ["sessions", "get", answer.data.threadId, "--format", "json"],
        { home },
      ),
    );
    assert.equal(session.data.messages[0].role, "user");
    assert.equal(
      session.data.messages.at(-1).content,
      "Mock answer from Cloudeval AI.",
    );

    const search = parseJson(
      await runCli(["sessions", "search", "Mock answer", "--format", "json"], {
        home,
      }),
    );
    assert.equal(search.command, "sessions search");
    assert.equal(search.data[0].threadId, answer.data.threadId);

    const renamed = parseJson(
      await runCli(
        [
          "sessions",
          "rename",
          answer.data.threadId,
          "Reusable thread",
          "--format",
          "json",
        ],
        { home },
      ),
    );
    assert.equal(renamed.command, "sessions rename");
    assert.equal(renamed.data.title, "Reusable thread");

    const streamRequest = backend.requests.find(
      (request) => request.path === "/api/v1/chat/stream",
    );
    assert(streamRequest);
    const payload = JSON.parse(streamRequest.body);
    assert.equal(payload.thread_id, "thread-reuse");
    assert.equal(payload.project.id, "project-main");
    assert.equal(payload.settings.model, "gpt-5-mini");
    assert.equal(payload.settings.mode, "ask");
    assert.equal(streamRequest.authorization, "Bearer test-token");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await backend.close();
  }
});

test("agent streams a task non-interactively with agent mode settings", async () => {
  const backend = await startBackend();
  const home = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudeval-cli-agent-home-"),
  );
  try {
    const answer = parseJson(
      await runCli(
        [
          "agent",
          "review",
          "cloud",
          "risks",
          "--base-url",
          backend.baseUrl,
          "--access-key",
          "test-token",
          "--project",
          "project-main",
          "--model",
          "gpt-5-mini",
          "--format",
          "json",
          "--non-interactive",
          "--progress",
          "none",
        ],
        { home },
      ),
    );

    assert.equal(answer.command, "agent");
    assert.equal(answer.data.response, "Mock answer from Cloudeval AI.");
    assert.equal(answer.data.project.id, "project-main");

    const streamRequest = backend.requests.find(
      (request) => request.path === "/api/v1/chat/stream",
    );
    assert(streamRequest);
    const payload = JSON.parse(streamRequest.body);
    assert.equal(payload.message, "review cloud risks");
    assert.equal(payload.settings.model, "gpt-5-mini");
    assert.equal(payload.settings.mode, "agent");
    assert.equal(payload.agent_profile_id, undefined);
    assert.equal(payload.input.agent_profile_id, undefined);
    assert.equal(streamRequest.authorization, "Bearer test-token");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await backend.close();
  }
});

test("agent prints thinking progress and fails clearly when no final answer is returned", async () => {
  const backend = await startBackend();
  try {
    const progress = await runCli([
      "agent",
      "thinking",
      "progress",
      "--base-url",
      backend.baseUrl,
      "--access-key",
      "test-token",
      "--project",
      "project-main",
      "--format",
      "text",
      "--progress",
      "stderr",
      "--non-interactive",
    ]);
    assert.equal(progress.exitCode, 0, progress.stderr);
    assert.equal(progress.stdout, "Report summary ready.\n");
    assert.match(progress.stderr, /\[thinking\] Loading cost reports/);
    assert.match(progress.stderr, /\[thinking\] Loaded cost reports/);

    const empty = await runCli([
      "agent",
      "empty",
      "agent",
      "result",
      "--base-url",
      backend.baseUrl,
      "--access-key",
      "test-token",
      "--project",
      "project-main",
      "--format",
      "text",
      "--progress",
      "stderr",
      "--non-interactive",
    ]);
    assert.equal(empty.exitCode, 1);
    assert.equal(empty.stdout, "");
    assert.match(empty.stderr, /\[thinking\] Loading cost reports/);
    assert.match(empty.stderr, /No final response returned by CloudEval/);
    assert.match(empty.stderr, /last stream status: complete/);
  } finally {
    await backend.close();
  }
});

test("agent reports HITL approval requests instead of an empty final response", async () => {
  const backend = await startBackend();
  try {
    const json = await runCli(
      [
        "agent",
        "hitl",
        "approval",
        "--base-url",
        backend.baseUrl,
        "--access-key-stdin",
        "--project",
        "project-main",
        "--format",
        "json",
        "--progress",
        "none",
        "--non-interactive",
      ],
      { input: "test-token" },
    );

    assert.equal(json.exitCode, 6);
    assert.equal(json.stderr, "");
    const body = JSON.parse(json.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.command, "agent");
    assert.equal(body.error.code, "HITL_REQUIRED");
    assert.match(body.error.message, /Human input required/);
    assert.equal(body.data.hitl.checkpointId, "ckpt-cost-1");
    assert.equal(body.data.hitl.questions[0].id, "approval_0");
    assert.equal(body.data.hitl.questions[0].options[0].id, "approve");

    const text = await runCli(
      [
        "agent",
        "hitl",
        "approval",
        "--base-url",
        backend.baseUrl,
        "--access-key-stdin",
        "--project",
        "project-main",
        "--format",
        "text",
        "--progress",
        "stderr",
        "--non-interactive",
      ],
      { input: "test-token" },
    );

    assert.equal(text.exitCode, 6);
    assert.equal(text.stdout, "");
    assert.match(text.stderr, /Human input required/);
    assert.match(text.stderr, /Regenerate cost report/);
    assert.doesNotMatch(text.stderr, /No final response returned/);
  } finally {
    await backend.close();
  }
});

test("agent routes progress, data, errors, and verbose logs to the correct streams", async () => {
  const backend = await startBackend();
  try {
    const text = await runCli(
      [
        "agent",
        "thinking",
        "progress",
        "--base-url",
        backend.baseUrl,
        "--access-key-stdin",
        "--project",
        "project-main",
        "--format",
        "text",
        "--progress",
        "stderr",
        "--non-interactive",
      ],
      { input: "test-token" },
    );
    assert.equal(text.exitCode, 0, text.stderr);
    assert.equal(text.stdout, "Report summary ready.\n");
    assert.match(text.stderr, /\[auth\] Resolving authentication/);
    assert.match(text.stderr, /\[thinking\] Loading cost reports/);
    assert.doesNotMatch(text.stdout, /\[thinking\]|\[request\]|\[auth\]/);
    assert.doesNotMatch(text.stderr, /Report summary ready\./);

    const ndjson = await runCli(
      [
        "agent",
        "thinking",
        "progress",
        "--base-url",
        backend.baseUrl,
        "--access-key-stdin",
        "--project",
        "project-main",
        "--format",
        "ndjson",
        "--progress",
        "ndjson",
        "--non-interactive",
      ],
      { input: "test-token" },
    );
    assert.equal(ndjson.exitCode, 0, ndjson.stderr);
    assert.equal(ndjson.stderr, "");
    const events = ndjson.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) => event.type),
      ["auth", "request", "request", "thinking", "thinking", "chunk", "result"],
    );
    assert.equal(
      events.find((event) => event.type === "chunk")?.content,
      "Report summary ready.",
    );
    assert.equal(events.at(-1).data.response, "Report summary ready.");

    const jsonError = await runCli(
      [
        "agent",
        "empty",
        "agent",
        "result",
        "--base-url",
        backend.baseUrl,
        "--access-key-stdin",
        "--project",
        "project-main",
        "--format",
        "json",
        "--progress",
        "none",
        "--non-interactive",
      ],
      { input: "test-token" },
    );
    assert.equal(jsonError.exitCode, 1);
    assert.equal(jsonError.stderr, "");
    const jsonErrorBody = JSON.parse(jsonError.stdout);
    assert.equal(jsonErrorBody.ok, false);
    assert.equal(jsonErrorBody.command, "agent");
    assert.match(
      jsonErrorBody.error.message,
      /No final response returned by CloudEval/,
    );

    const verbose = await runCli(
      [
        "agent",
        "thinking",
        "progress",
        "--base-url",
        backend.baseUrl,
        "--access-key-stdin",
        "--project",
        "project-main",
        "--format",
        "json",
        "--progress",
        "none",
        "--non-interactive",
        "--verbose",
      ],
      { input: "test-token" },
    );
    assert.equal(verbose.exitCode, 0, verbose.stderr);
    const verboseBody = JSON.parse(verbose.stdout);
    assert.equal(verboseBody.ok, true);
    assert.equal(verboseBody.data.response, "Report summary ready.");
    assert.match(verbose.stderr, /\[VERBOSE\]/);
    assert.doesNotMatch(verbose.stderr, /test-token/);
  } finally {
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
      "--access-key",
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
      backend.requests.some(
        (request) => request.path === "/api/v1/chat/stream",
      ),
      false,
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
      "--access-key",
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
      "--access-key",
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
    const events = ndjson.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) => event.type),
      ["auth", "request", "request", "chunk", "result"],
    );
    assert.equal(events.at(-1).data.response, "Mock answer from Cloudeval AI.");
  } finally {
    await backend.close();
  }
});
