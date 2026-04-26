import assert from "node:assert/strict";
import test from "node:test";
import {
  getCostReport,
  getReportJobStatus,
  getReport,
  getWafReport,
  listReports,
  runReports,
} from "./reportsClient";

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const withFetch = async (
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<void>
) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = ((url: URL | RequestInfo, init?: RequestInit) =>
    handler(String(url), init)) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
  }
};

test("listReports sends filters and normalizes response envelopes", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  await withFetch(
    (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        items: [
          {
            report_id: "latest:project-1:cost",
            report_type: "cost",
            project_id: "project-1",
            generated_at: "2026-04-25T10:00:00Z",
            metrics: { monthly_cost: 48200, currency: "USD" },
          },
        ],
      });
    },
    async () => {
      const reports = await listReports({
        baseUrl: "https://example.com/api/v1",
        authToken: "token-1",
        projectId: "project-1",
        kind: "cost",
        userId: "user-1",
      });

      assert.equal(calls.length, 1);
      assert.equal(
        calls[0].url,
        "https://example.com/api/v1/reports/history?user_id=user-1&project_ids=project-1&report_type=cost"
      );
      assert.equal(
        (calls[0].init?.headers as Record<string, string>).Authorization,
        "Bearer token-1"
      );
      assert.equal(reports[0].projectId, "project-1");
      assert.equal(reports[0].generatedAt, "2026-04-25T10:00:00Z");
      assert.equal((reports[0].parsed as any).totalSpend.amount, 48200);
    }
  );
});

test("getReport fetches a report by id and includes the requested view", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  await withFetch(
    (url, init) => {
      calls.push({ url, init });
      if (url.includes("/reports/history")) {
        return jsonResponse({
          items: [
            {
              report_id: "latest:project-1:architecture",
              report_type: "architecture",
              project_id: "project-1",
              generated_at: "2026-04-25T11:00:00Z",
              is_latest: true,
            },
          ],
        });
      }
      return jsonResponse({
        project_id: "project-1",
        report_type: "architecture",
        timestamp: "2026-04-25T11:00:00Z",
        report: {
          id: "rpt-waf-1",
          processed: { overall_score: 74 },
          all_rules: [],
        },
      });
    },
    async () => {
      const report = await getReport({
        baseUrl: "https://example.com/api/v1",
        authToken: "token-1",
        projectId: "project-1",
        reportId: "latest:project-1:architecture",
        view: "raw",
        userId: "user-1",
      });

      assert.equal(
        calls[1].url,
        "https://example.com/api/v1/reports/detail/project-1/architecture?user_id=user-1"
      );
      assert.equal(report.kind, "waf");
      assert.equal((report.parsed as any).score.overall, 74);
    }
  );
});

test("kind-specific report helpers call cost and waf endpoints", async () => {
  const urls: string[] = [];
  await withFetch(
    (url) => {
      urls.push(url);
      return jsonResponse({
        project_id: "project-1",
        report_type: url.includes("/architecture") ? "architecture" : "cost",
        timestamp: "2026-04-25T12:00:00Z",
        report: url.includes("/architecture")
          ? { id: "rpt-waf-latest", processed: { overall_score: 91 }, all_rules: [] }
          : { id: "rpt-cost-latest", processed: { total_monthly_cost: 10, currency: "USD" } },
      });
    },
    async () => {
      await getCostReport({
        baseUrl: "https://example.com/api/v1",
        authToken: "token-1",
        projectId: "project-1",
        period: "30d",
        view: "recommendations",
        userId: "user-1",
      });
      await getWafReport({
        baseUrl: "https://example.com/api/v1",
        authToken: "token-1",
        projectId: "project-1",
        severity: "high",
        view: "rules",
        userId: "user-1",
      });

      assert.equal(
        urls[0],
        "https://example.com/api/v1/reports/detail/project-1/cost?user_id=user-1"
      );
      assert.equal(
        urls[1],
        "https://example.com/api/v1/reports/detail/project-1/architecture?user_id=user-1"
      );
    }
  );
});

test("runReports posts direct regeneration requests and polls jobs", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  await withFetch(
    (url, init) => {
      calls.push({ url, method: init?.method });
      if (url.includes("/jobs/job-cost-1")) {
        return jsonResponse({ job_id: "job-cost-1", status: "completed", progress: 100 });
      }
      if (url.includes("/cost-reports/")) {
        return jsonResponse({ job: { job_id: "job-cost-1", status: "submitted" } }, { status: 202 });
      }
      if (url.includes("/well-architected-reports/")) {
        return jsonResponse({ job: { job_id: "job-waf-1", status: "submitted" } }, { status: 202 });
      }
      return jsonResponse({ job: { job_id: "job-tests-1", status: "submitted" } }, { status: 202 });
    },
    async () => {
      const submitted = await runReports({
        baseUrl: "https://example.com/api/v1",
        authToken: "token-1",
        projectId: "project-1",
        userId: "user-1",
        type: "all",
      });
      const status = await getReportJobStatus({
        baseUrl: "https://example.com/api/v1",
        authToken: "token-1",
        userId: "user-1",
        jobId: "job-cost-1",
      });

      assert.equal(submitted.length, 3);
      assert.equal(calls[0].method, "POST");
      assert.equal(
        calls[0].url,
        "https://example.com/api/v1/cost-reports/project-1/regenerate?user_id=user-1"
      );
      assert.equal(
        calls[1].url,
        "https://example.com/api/v1/well-architected-reports/project-1/regenerate?user_id=user-1"
      );
      assert.equal(
        calls[2].url,
        "https://example.com/api/v1/reports/project-1/unit-tests/regenerate?user_id=user-1"
      );
      assert.deepEqual(status, { job_id: "job-cost-1", status: "completed", progress: 100 });
    }
  );
});
