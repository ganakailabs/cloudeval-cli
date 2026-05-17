import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentProfileRequestError,
  getAgentProfile,
  isAgentProfileAuthRequiredError,
  isAgentProfileDiscoveryFallbackError,
  listAgentProfiles,
} from "./agentProfilesClient.js";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("agent profile client marks auth-required catalog errors", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    jsonResponse(
      {
        error: "Authentication required for this endpoint",
        code: "AUTH_REQUIRED_PUBLIC",
        requiresAuth: true,
      },
      401,
    );

  try {
    await assert.rejects(
      () => listAgentProfiles({ baseUrl: "http://127.0.0.1:8787/api/v1" }),
      (error: unknown) => {
        assert(error instanceof AgentProfileRequestError);
        assert.equal(error.status, 401);
        assert.equal(error.code, "AUTH_REQUIRED_PUBLIC");
        assert.equal(error.requiresAuth, true);
        assert.equal(isAgentProfileAuthRequiredError(error), true);
        assert.equal(isAgentProfileDiscoveryFallbackError(error), true);
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("agent profile client treats missing catalog routes as discovery fallback only", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => jsonResponse({ detail: "not found" }, 404);

  try {
    await assert.rejects(
      () =>
        getAgentProfile({
          baseUrl: "http://127.0.0.1:8787/api/v1",
          profileId: "missing",
        }),
      (error: unknown) => {
        assert(error instanceof AgentProfileRequestError);
        assert.equal(error.status, 404);
        assert.equal(isAgentProfileAuthRequiredError(error), false);
        assert.equal(isAgentProfileDiscoveryFallbackError(error), true);
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});
