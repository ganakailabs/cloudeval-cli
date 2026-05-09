import assert from "node:assert/strict";
import test from "node:test";
import {
  createCredential,
  getCapabilities,
  getCredential,
  getCredentialTemplates,
  getIdentity,
  listCredentials,
  revokeCredential,
} from "./credentialsClient.js";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("credential client calls canonical credential endpoints", async () => {
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  global.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });

    if (url.endsWith("/api/v1/credential-templates")) {
      return jsonResponse({ templates: [{ id: "ci" }] });
    }
    if (url.endsWith("/api/v1/credentials?project_id=project-main")) {
      return jsonResponse({ credentials: [{ id: "cred-main" }] });
    }
    if (url.endsWith("/api/v1/credentials") && init?.method === "POST") {
      assert.equal((init.headers as Record<string, string>)["Idempotency-Key"], "idem-create");
      assert.deepEqual(JSON.parse(String(init.body)), {
        template: "ci",
        name: "github-actions-prod",
        project_id: "project-main",
        expires: "90d",
      });
      return jsonResponse({ credential: { id: "cred-created" }, access_key: "cev_test_ak_secret" }, 201);
    }
    if (url.endsWith("/api/v1/credentials/cred-main") && init?.method !== "POST") {
      return jsonResponse({ credential: { id: "cred-main" } });
    }
    if (url.endsWith("/api/v1/credentials/cred-main/revoke")) {
      assert.equal((init?.headers as Record<string, string>)["Idempotency-Key"], "idem-revoke");
      assert.deepEqual(JSON.parse(String(init?.body)), { reason: "rotated" });
      return jsonResponse({ credential: { id: "cred-main", status: "revoked" } });
    }
    if (url.endsWith("/api/v1/identity")) {
      return jsonResponse({ identity: { type: "user" } });
    }
    if (url.endsWith("/api/v1/capabilities")) {
      return jsonResponse({ allowed_tools: [{ name: "reports.run" }] });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  try {
    assert.deepEqual(await getCredentialTemplates({ baseUrl: "http://127.0.0.1:8787", authToken: "token" }), {
      templates: [{ id: "ci" }],
    });
    assert.deepEqual(await listCredentials({ baseUrl: "http://127.0.0.1:8787", authToken: "token", projectId: "project-main" }), {
      credentials: [{ id: "cred-main" }],
    });
    assert.deepEqual(await createCredential({
      baseUrl: "http://127.0.0.1:8787",
      authToken: "token",
      template: "ci",
      name: "github-actions-prod",
      projectId: "project-main",
      expires: "90d",
      idempotencyKey: "idem-create",
    }), { credential: { id: "cred-created" }, access_key: "cev_test_ak_secret" });
    assert.deepEqual(await getCredential({ baseUrl: "http://127.0.0.1:8787", authToken: "token", credentialId: "cred-main" }), {
      credential: { id: "cred-main" },
    });
    assert.deepEqual(await revokeCredential({
      baseUrl: "http://127.0.0.1:8787",
      authToken: "token",
      credentialId: "cred-main",
      reason: "rotated",
      idempotencyKey: "idem-revoke",
    }), { credential: { id: "cred-main", status: "revoked" } });
    assert.deepEqual(await getIdentity({ baseUrl: "http://127.0.0.1:8787", authToken: "token" }), {
      identity: { type: "user" },
    });
    assert.deepEqual(await getCapabilities({ baseUrl: "http://127.0.0.1:8787", authToken: "token" }), {
      allowed_tools: [{ name: "reports.run" }],
    });
    assert.equal(
      calls.every((call) => (call.init?.headers as Record<string, string>).Authorization === "Bearer token"),
      true
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("credential client generates idempotency keys for mutations", async () => {
  const originalFetch = global.fetch;
  const keys: string[] = [];
  global.fetch = async (_input, init) => {
    keys.push((init?.headers as Record<string, string>)["Idempotency-Key"]);
    return jsonResponse({ credential: { id: "cred-generated" } }, 201);
  };

  try {
    await createCredential({
      baseUrl: "http://127.0.0.1:8787",
      authToken: "token",
      template: "ci",
      name: "generated",
      projectId: "project-main",
    });
    await revokeCredential({
      baseUrl: "http://127.0.0.1:8787",
      authToken: "token",
      credentialId: "cred-generated",
    });
    assert.match(keys[0] ?? "", /^[0-9a-f-]{36}$/);
    assert.match(keys[1] ?? "", /^[0-9a-f-]{36}$/);
  } finally {
    global.fetch = originalFetch;
  }
});
