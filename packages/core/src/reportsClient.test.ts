import assert from "node:assert/strict";
import test from "node:test";
import {
  getCostReport,
  getReport,
  getWafReport,
  listReports,
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
        reports: [
          {
            id: "rpt-cost-1",
            kind: "cost",
            project_id: "project-1",
            generated_at: "2026-04-25T10:00:00Z",
            raw: { provider_payload: true },
            parsed: { totalSpend: { amount: 48200, currency: "USD" } },
            formatted: { title: "Cost report", summary: "Spend is up.", sections: [] },
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
      });

      assert.equal(calls.length, 1);
      assert.equal(
        calls[0].url,
        "https://example.com/api/v1/reports?project_id=project-1&kind=cost"
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
      return jsonResponse({
        id: "rpt-waf-1",
        kind: "waf",
        projectId: "project-1",
        generatedAt: "2026-04-25T11:00:00Z",
        raw: { ruleResults: [] },
        parsed: { score: 74 },
      });
    },
    async () => {
      const report = await getReport({
        baseUrl: "https://example.com/api/v1",
        authToken: "token-1",
        projectId: "project-1",
        reportId: "rpt-waf-1",
        view: "raw",
      });

      assert.equal(
        calls[0].url,
        "https://example.com/api/v1/reports/rpt-waf-1?project_id=project-1&view=raw"
      );
      assert.equal(report.kind, "waf");
      assert.equal((report.parsed as any).score, 74);
    }
  );
});

test("kind-specific report helpers call cost and waf endpoints", async () => {
  const urls: string[] = [];
  await withFetch(
    (url) => {
      urls.push(url);
      return jsonResponse({
        id: url.includes("/waf") ? "rpt-waf-latest" : "rpt-cost-latest",
        kind: url.includes("/waf") ? "waf" : "cost",
        project_id: "project-1",
        generated_at: "2026-04-25T12:00:00Z",
        raw: {},
        parsed: {},
      });
    },
    async () => {
      await getCostReport({
        baseUrl: "https://example.com/api/v1",
        authToken: "token-1",
        projectId: "project-1",
        period: "30d",
        view: "recommendations",
      });
      await getWafReport({
        baseUrl: "https://example.com/api/v1",
        authToken: "token-1",
        projectId: "project-1",
        severity: "high",
        view: "rules",
      });

      assert.equal(
        urls[0],
        "https://example.com/api/v1/reports/cost?project_id=project-1&period=30d&view=recommendations"
      );
      assert.equal(
        urls[1],
        "https://example.com/api/v1/reports/waf?project_id=project-1&severity=high&view=rules"
      );
    }
  );
});
