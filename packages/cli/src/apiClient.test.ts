import assert from "node:assert/strict";
import test from "node:test";
import { fetchCloudEvalJson } from "./apiClient";

test("fetchCloudEvalJson redacts sensitive backend error details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        detail:
          "failed access_key=cev_test_ak_01JTEST_backendsecret client_secret=plain-secret",
      }),
      { status: 403 },
    );

  try {
    await assert.rejects(
      () =>
        fetchCloudEvalJson({
          baseUrl: "https://api.example.test",
          path: "/api/v1/projects",
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /access_key=\[redacted\]/);
        assert.match(error.message, /client_secret=\[redacted\]/);
        assert.doesNotMatch(error.message, /backendsecret/);
        assert.doesNotMatch(error.message, /plain-secret/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
