import { listActionCenterItems } from "./actionCenterClient.js";
import { getCLIHeaders, normalizeApiBase } from "./auth.js";

const withFetch = async (
  handler: (fetchImpl: typeof fetch) => Promise<void>
): Promise<void> => {
  const originalFetch = globalThis.fetch;
  try {
    await handler(originalFetch);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

void withFetch(async (fetchImpl) => {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.includes("/issues/items")) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    return new Response(
      JSON.stringify({
        user_id: "user-1",
        items: [],
        total_count: 0,
        limit: 50,
        offset: 0,
        signals: {
          architecture_issues_total: 0,
          cost_opportunities_total: 0,
          unit_test_failures_total: 0,
          projects_scanned: 0,
          projects_with_reports: 0,
        },
        generated_at: "2026-03-18T10:00:00+00:00",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const result = await listActionCenterItems({
    baseUrl: "https://api.example.com",
    authToken: "token",
    userId: "user-1",
    types: ["architecture", "cost"],
    severities: ["critical"],
    projectIds: ["proj-1"],
    q: "storage",
    sort: "severity",
    limit: 25,
    offset: 50,
  });

  if (!result || typeof result !== "object") {
    throw new Error("Expected action center list response object.");
  }
});

void withFetch(async () => {
  let capturedUrl = "";
  globalThis.fetch = async (input) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await listActionCenterItems({
    baseUrl: normalizeApiBase("https://api.example.com"),
    userId: "user-1",
    types: ["architecture"],
  });

  const url = new URL(capturedUrl);
  if (!url.pathname.endsWith("/issues/items")) {
    throw new Error(`Unexpected pathname: ${url.pathname}`);
  }
  if (url.searchParams.get("user_id") !== "user-1") {
    throw new Error("Missing user_id query param.");
  }
  if (url.searchParams.getAll("type").join(",") !== "architecture") {
    throw new Error("Missing type query param.");
  }
  const headers = getCLIHeaders("token");
  if (!headers.Authorization) {
    throw new Error("Expected auth header helper to exist.");
  }
});
