import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const importFreshAuthModule = async (homeDir: string) => {
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    const moduleUrl = new URL(`./auth.ts?test=${Date.now()}-${Math.random()}`, import.meta.url);
    return await import(moduleUrl.href);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });

test("normalizeApiBase appends api/v1 exactly once", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const { normalizeApiBase } = await importFreshAuthModule(tempHome);

  assert.equal(normalizeApiBase(), "https://cloudeval.ai/api/proxy/v1");
  assert.equal(
    normalizeApiBase("https://cloudeval.ai"),
    "https://cloudeval.ai/api/proxy/v1"
  );
  assert.equal(
    normalizeApiBase("https://cloudeval.ai/api"),
    "https://cloudeval.ai/api/proxy/v1"
  );
  assert.equal(
    normalizeApiBase("https://cloudeval.ai/api/proxy"),
    "https://cloudeval.ai/api/proxy/v1"
  );
  assert.equal(
    normalizeApiBase("https://cloudeval.ai/api/proxy/v1"),
    "https://cloudeval.ai/api/proxy/v1"
  );
  assert.equal(
    normalizeApiBase("https://cloudeval.ai/api/v1"),
    "https://cloudeval.ai/api/proxy/v1"
  );
});

test("assertSecureBaseUrl rejects insecure non-localhost URLs", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const { assertSecureBaseUrl } = await importFreshAuthModule(tempHome);

  assert.doesNotThrow(() => assertSecureBaseUrl("https://cloudeval.ai"));
  assert.doesNotThrow(() => assertSecureBaseUrl("https://cloudeval.ai/api/proxy/v1"));
  assert.doesNotThrow(() => assertSecureBaseUrl("http://127.0.0.1:8787"));
  assert.throws(
    () => assertSecureBaseUrl("http://example.com"),
    /Refusing insecure base URL/
  );
});

test("device code flow uses the CLI client id for both requests", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const { loginWithDeviceCode } = await importFreshAuthModule(tempHome);
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalLog = console.log;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  global.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const bodyText = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    requests.push({ url, body });

    if (url.endsWith("/auth/device/code")) {
      return jsonResponse({
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://login.example.com/device",
        expires_in: 60,
        interval: 1,
      });
    }

    if (url.endsWith("/auth/device/token")) {
      return jsonResponse({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  global.setTimeout = ((callback: (...args: unknown[]) => void) => {
    queueMicrotask(() => callback());
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  console.log = () => {};
  process.stdout.write = (() => true) as typeof process.stdout.write;

  try {
    const token = await loginWithDeviceCode("http://127.0.0.1:8787");
    assert.equal(token, "access-token");
    assert.deepEqual(
      requests.map((request) => request.body.client_id),
      ["cloudeval-cli", "cloudeval-cli"]
    );
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }
});

test("device code login fails instead of falling back when backend bootstrap is protected", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const { loginWithDeviceCode } = await importFreshAuthModule(tempHome);
  const originalFetch = global.fetch;
  const requests: string[] = [];

  global.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    requests.push(url);

    if (url.endsWith("/auth/device/code")) {
      return jsonResponse({ message: "Authentication required" }, 401);
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await assert.rejects(
      () => loginWithDeviceCode("https://cloudeval.ai"),
      /Failed to initiate login: 401/
    );
    assert.deepEqual(requests, [
      "https://cloudeval.ai/api/v1/auth/device/code",
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("stored refresh uses the direct auth backend for cloudeval proxy base URLs", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const previousOverride = process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
  process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = "1";

  try {
    const { getAuthToken } = await importFreshAuthModule(tempHome);
    const configDir = path.join(tempHome, ".config", "cloudeval");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          refreshTokenRef: "refresh-token",
          baseUrl: "https://cloudeval.ai/api/proxy/v1",
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(configDir, "secrets.json"),
      JSON.stringify(
        {
          "refresh-token": "backend-refresh-token",
        },
        null,
        2
      )
    );

    const originalFetch = global.fetch;
    const requests: string[] = [];
    global.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push(url);
      assert.equal(url, "https://cloudeval.ai/api/v1/auth/refresh");
      assert.equal(JSON.parse(String(init?.body)).refresh_token, "backend-refresh-token");
      return jsonResponse({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    };

    try {
      const token = await getAuthToken({
        baseUrl: "https://cloudeval.ai/api/proxy/v1",
      });
      assert.equal(token, "new-access-token");
      assert.deepEqual(requests, ["https://cloudeval.ai/api/v1/auth/refresh"]);
    } finally {
      global.fetch = originalFetch;
    }
  } finally {
    if (previousOverride === undefined) {
      delete process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
    } else {
      process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = previousOverride;
    }
  }
});

test("insecure file storage override takes precedence over OS backends", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const previousOverride = process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
  process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = "1";

  try {
    const { getAuthStatus } = await importFreshAuthModule(tempHome);
    const status = await getAuthStatus("http://127.0.0.1:8787");
    assert.equal(status.storageBackend, "insecure-file");
  } finally {
    if (previousOverride === undefined) {
      delete process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
    } else {
      process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = previousOverride;
    }
  }
});

test("validated auth status reports revoked refresh tokens as unauthenticated", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const previousOverride = process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
  process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = "1";

  try {
    const { getAuthStatus } = await importFreshAuthModule(tempHome);
    const configDir = path.join(tempHome, ".config", "cloudeval");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          refreshTokenRef: "refresh-token",
          baseUrl: "http://127.0.0.1:8787/api/v1",
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(configDir, "secrets.json"),
      JSON.stringify(
        {
          "refresh-token": "revoked-refresh-token",
        },
        null,
        2
      )
    );

    const originalFetch = global.fetch;
    global.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      assert.match(url, /\/auth\/refresh$/);
      return jsonResponse({ detail: "invalid_grant" }, 401);
    };

    try {
      const status = await getAuthStatus("http://127.0.0.1:8787", {
        validate: true,
      });
      assert.equal(status.authenticated, false);
      assert.equal(status.hasRefreshToken, false);
      assert.equal(status.validationAttempted, true);
      assert.match(status.authError, /invalid_grant|No authentication available/);
    } finally {
      global.fetch = originalFetch;
    }
  } finally {
    if (previousOverride === undefined) {
      delete process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
    } else {
      process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = previousOverride;
    }
  }
});

test("stored refresh fails instead of falling back when the backend rejects refresh", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const previousOverride = process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
  process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = "1";

  try {
    const { getAuthToken } = await importFreshAuthModule(tempHome);
    const configDir = path.join(tempHome, ".config", "cloudeval");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          refreshTokenRef: "refresh-token",
          baseUrl: "https://cloudeval.ai/api/proxy/v1",
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(configDir, "secrets.json"),
      JSON.stringify(
        {
          "refresh-token": "backend-refresh-token",
        },
        null,
        2
      )
    );

    const originalFetch = global.fetch;
    const requests: string[] = [];
    global.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push(url);
      assert.equal(url, "https://cloudeval.ai/api/v1/auth/refresh");
      return jsonResponse(
        {
          error: "Authentication required for this endpoint",
          code: "AUTH_REQUIRED_PUBLIC",
        },
        401
      );
    };

    try {
      await assert.rejects(
        () =>
          getAuthToken({
            baseUrl: "https://cloudeval.ai/api/proxy/v1",
          }),
        /No authentication available|Stored refresh failed|Token refresh unavailable/
      );
      assert.deepEqual(requests, ["https://cloudeval.ai/api/v1/auth/refresh"]);
    } finally {
      global.fetch = originalFetch;
    }
  } finally {
    if (previousOverride === undefined) {
      delete process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
    } else {
      process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = previousOverride;
    }
  }
});

test("validated auth status clears refresh tokens rejected by consent errors", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const previousOverride = process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
  process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = "1";

  try {
    const { getAuthStatus } = await importFreshAuthModule(tempHome);
    const configDir = path.join(tempHome, ".config", "cloudeval");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          refreshTokenRef: "refresh-token",
          baseUrl: "https://cloudeval.ai/api/proxy/v1",
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(configDir, "secrets.json"),
      JSON.stringify(
        {
          "refresh-token": "consent-required-refresh-token",
        },
        null,
        2
      )
    );

    const originalFetch = global.fetch;
    const seenUrls: string[] = [];
    global.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      seenUrls.push(url);
      return jsonResponse(
        {
          error: "consent_required",
          error_description: "AADSTS65001: The user or administrator has not consented.",
        },
        400
      );
    };

    try {
      const status = await getAuthStatus("https://cloudeval.ai/api/proxy/v1", {
        validate: true,
      });
      assert.equal(status.authenticated, false);
      assert.equal(status.hasRefreshToken, false);
      assert.equal(status.validationAttempted, true);
      assert.deepEqual(seenUrls, ["https://cloudeval.ai/api/v1/auth/refresh"]);
    } finally {
      global.fetch = originalFetch;
    }
  } finally {
    if (previousOverride === undefined) {
      delete process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
    } else {
      process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = previousOverride;
    }
  }
});

test("validated auth status clears stored auth when backend rejects current user lookup", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const previousOverride = process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
  process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = "1";

  try {
    const { getAuthStatus } = await importFreshAuthModule(tempHome);
    const configDir = path.join(tempHome, ".config", "cloudeval");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          tokenRef: "access-token",
          tokenExpiresAt: Date.now() + 3_600_000,
          baseUrl: "https://cloudeval.ai/api/proxy/v1",
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(configDir, "secrets.json"),
      JSON.stringify(
        {
          "access-token": "stored-access-token",
        },
        null,
        2
      )
    );

    const originalFetch = global.fetch;
    global.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      assert.match(url, /\/auth\/me$/);
      return jsonResponse(
        {
          error: "Authentication required for this endpoint",
          code: "AUTH_REQUIRED_PUBLIC",
        },
        401
      );
    };

    try {
      const status = await getAuthStatus("https://cloudeval.ai/api/proxy/v1", {
        validate: true,
      });
      assert.equal(status.authenticated, false);
      assert.equal(status.accessTokenCached, false);
      assert.equal(status.hasRefreshToken, false);
      assert.equal(status.validationAttempted, true);
      assert.match(status.authError, /Current user lookup failed: 401/);
      assert.equal(fs.existsSync(path.join(configDir, "config.json")), false);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(configDir, "secrets.json"), "utf8")),
        {}
      );
    } finally {
      global.fetch = originalFetch;
    }
  } finally {
    if (previousOverride === undefined) {
      delete process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
    } else {
      process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = previousOverride;
    }
  }
});

test("getAuthToken retries with the latest persisted refresh token after a concurrent refresh", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const previousOverride = process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
  process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = "1";

  try {
    const { getAuthToken } = await importFreshAuthModule(tempHome);
    const configDir = path.join(tempHome, ".config", "cloudeval");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          refreshTokenRef: "refresh-token",
          baseUrl: "http://127.0.0.1:8787/api/v1",
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(configDir, "secrets.json"),
      JSON.stringify(
        {
          "refresh-token": "stale-refresh-token",
        },
        null,
        2
      )
    );

    const originalFetch = global.fetch;
    const seenRefreshTokens: string[] = [];

    global.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      assert.match(url, /\/auth\/refresh$/);
      const body = JSON.parse(String(init?.body ?? "{}")) as { refresh_token?: string };
      seenRefreshTokens.push(body.refresh_token ?? "");

      if (body.refresh_token === "stale-refresh-token") {
        fs.writeFileSync(
          path.join(configDir, "secrets.json"),
          JSON.stringify(
            {
              "refresh-token": "fresh-refresh-token",
            },
            null,
            2
          )
        );
        return jsonResponse({ message: "Invalid refresh token" }, 401);
      }

      if (body.refresh_token === "fresh-refresh-token") {
        return jsonResponse({
          access_token: "fresh-access-token",
          refresh_token: "freshest-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      throw new Error(`Unexpected refresh token: ${body.refresh_token}`);
    };

    try {
      const token = await getAuthToken({
        baseUrl: "http://127.0.0.1:8787",
      });
      assert.equal(token, "fresh-access-token");
      assert.deepEqual(seenRefreshTokens, [
        "stale-refresh-token",
        "fresh-refresh-token",
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  } finally {
    if (previousOverride === undefined) {
      delete process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
    } else {
      process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = previousOverride;
    }
  }
});

test("getAuthToken refreshes saved interactive logins against the stored auth base URL", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const previousOverride = process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
  process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = "1";

  try {
    const { getAuthToken } = await importFreshAuthModule(tempHome);
    const configDir = path.join(tempHome, ".config", "cloudeval");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          refreshTokenRef: "refresh-token",
          baseUrl: "https://stored-auth.example.com/api/v1",
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(configDir, "secrets.json"),
      JSON.stringify(
        {
          "refresh-token": "stored-refresh-token",
        },
        null,
        2
      )
    );

    const originalFetch = global.fetch;
    const seenUrls: string[] = [];

    global.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      seenUrls.push(url);
      assert.equal(url, "https://stored-auth.example.com/api/v1/auth/refresh");
      const body = JSON.parse(String(init?.body ?? "{}")) as { refresh_token?: string };
      assert.equal(body.refresh_token, "stored-refresh-token");
      return jsonResponse({
        access_token: "fresh-access-token",
        refresh_token: "fresh-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    };

    try {
      const token = await getAuthToken({
        baseUrl: "https://cloudeval.ai/api/proxy/v1",
      });
      assert.equal(token, "fresh-access-token");
      assert.deepEqual(seenUrls, ["https://stored-auth.example.com/api/v1/auth/refresh"]);
    } finally {
      global.fetch = originalFetch;
    }
  } finally {
    if (previousOverride === undefined) {
      delete process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
    } else {
      process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = previousOverride;
    }
  }
});

test("getAuthToken uses a secure persisted access token before refreshing", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const previousOverride = process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
  process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = "1";

  try {
    const { getAuthToken } = await importFreshAuthModule(tempHome);
    const configDir = path.join(tempHome, ".config", "cloudeval");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          tokenRef: "access-token",
          tokenExpiresAt: Date.now() + 3_600_000,
          refreshTokenRef: "refresh-token",
          baseUrl: "https://stored-auth.example.com/api/v1",
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(configDir, "secrets.json"),
      JSON.stringify(
        {
          "access-token": "stored-access-token",
          "refresh-token": "stored-refresh-token",
        },
        null,
        2
      )
    );

    const originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error("refresh should not be called when access token is still valid");
    };

    try {
      const token = await getAuthToken({
        baseUrl: "https://cloudeval.ai/api/proxy/v1",
      });
      assert.equal(token, "stored-access-token");
    } finally {
      global.fetch = originalFetch;
    }
  } finally {
    if (previousOverride === undefined) {
      delete process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
    } else {
      process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = previousOverride;
    }
  }
});

test("getAuthToken waits briefly for a concurrently persisted refresh token", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const previousOverride = process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
  process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = "1";

  try {
    const { getAuthToken } = await importFreshAuthModule(tempHome);
    const configDir = path.join(tempHome, ".config", "cloudeval");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          refreshTokenRef: "refresh-token",
          baseUrl: "http://127.0.0.1:8787/api/v1",
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(configDir, "secrets.json"),
      JSON.stringify(
        {
          "refresh-token": "stale-refresh-token",
        },
        null,
        2
      )
    );

    const originalFetch = global.fetch;
    const originalSetTimeout = global.setTimeout;
    const seenRefreshTokens: string[] = [];

    global.setTimeout = ((callback: (...args: unknown[]) => void) => {
      queueMicrotask(() => callback());
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;

    global.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      assert.match(url, /\/auth\/refresh$/);
      const body = JSON.parse(String(init?.body ?? "{}")) as { refresh_token?: string };
      seenRefreshTokens.push(body.refresh_token ?? "");

      if (body.refresh_token === "stale-refresh-token") {
        setTimeout(() => {
          fs.writeFileSync(
            path.join(configDir, "secrets.json"),
            JSON.stringify(
              {
                "refresh-token": "fresh-refresh-token",
              },
              null,
              2
            )
          );
        }, 0);

        return jsonResponse({ message: "Invalid refresh token" }, 401);
      }

      if (body.refresh_token === "fresh-refresh-token") {
        return jsonResponse({
          access_token: "fresh-access-token",
          refresh_token: "freshest-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      throw new Error(`Unexpected refresh token: ${body.refresh_token}`);
    };

    try {
      const token = await getAuthToken({
        baseUrl: "http://127.0.0.1:8787",
      });
      assert.equal(token, "fresh-access-token");
      assert.deepEqual(seenRefreshTokens, [
        "stale-refresh-token",
        "fresh-refresh-token",
      ]);
    } finally {
      global.fetch = originalFetch;
      global.setTimeout = originalSetTimeout;
    }
  } finally {
    if (previousOverride === undefined) {
      delete process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
    } else {
      process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = previousOverride;
    }
  }
});

test("getAuthToken removes a refresh lock owned by a dead process", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const previousOverride = process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
  process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = "1";

  try {
    const { getAuthToken } = await importFreshAuthModule(tempHome);
    const configDir = path.join(tempHome, ".config", "cloudeval");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          refreshTokenRef: "refresh-token",
          baseUrl: "http://127.0.0.1:8787/api/v1",
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(configDir, "secrets.json"),
      JSON.stringify(
        {
          "refresh-token": "refresh-token-value",
        },
        null,
        2
      )
    );
    fs.writeFileSync(path.join(configDir, "refresh.lock"), "999999999");

    const originalFetch = global.fetch;
    let refreshCalls = 0;
    global.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      assert.match(url, /\/auth\/refresh$/);
      const body = JSON.parse(String(init?.body ?? "{}")) as { refresh_token?: string };
      assert.equal(body.refresh_token, "refresh-token-value");
      refreshCalls++;
      return jsonResponse({
        access_token: "access-token",
        refresh_token: "new-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    };

    try {
      const token = await getAuthToken({
        baseUrl: "http://127.0.0.1:8787",
      });
      assert.equal(token, "access-token");
      assert.equal(refreshCalls, 1);
      assert.equal(fs.existsSync(path.join(configDir, "refresh.lock")), false);
    } finally {
      global.fetch = originalFetch;
    }
  } finally {
    if (previousOverride === undefined) {
      delete process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
    } else {
      process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = previousOverride;
    }
  }
});

test("login uses browser-assisted device flow", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const previousOverride = process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
  process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = "1";

  try {
    const { getAuthStatus, login } = await importFreshAuthModule(tempHome);
    const originalFetch = global.fetch;
    const originalSetTimeout = global.setTimeout;
    const originalLog = console.log;
    const originalWrite = process.stdout.write.bind(process.stdout);
    const requests: string[] = [];
    const openedUrls: string[] = [];

    global.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push(url);

      if (url.endsWith("/auth/device/code")) {
        return jsonResponse({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://cloudeval.ai/device/login",
          verification_uri_complete:
            "https://cloudeval.ai/device/login?user_code=ABCD-EFGH",
          expires_in: 60,
          interval: 1,
        });
      }

      if (url.endsWith("/auth/device/token")) {
        return jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    global.setTimeout = ((callback: (...args: unknown[]) => void) => {
      queueMicrotask(() => callback());
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;
    console.log = () => {};
    process.stdout.write = (() => true) as typeof process.stdout.write;

    try {
      const token = await login("https://cloudeval.ai", {
        browserOpener: (url: string) => {
          openedUrls.push(url);
          return true;
        },
      });
      assert.equal(token, "access-token");
      assert.deepEqual(openedUrls, [
        "https://cloudeval.ai/device/login?user_code=ABCD-EFGH",
      ]);
      assert.deepEqual(requests, [
        "https://cloudeval.ai/api/v1/auth/device/code",
        "https://cloudeval.ai/api/v1/auth/device/token",
      ]);

      const status = await getAuthStatus("https://cloudeval.ai/api/proxy/v1");
      assert.equal(status.baseUrl, "https://cloudeval.ai/api/proxy/v1");
    } finally {
      global.fetch = originalFetch;
      global.setTimeout = originalSetTimeout;
      console.log = originalLog;
      process.stdout.write = originalWrite;
    }
  } finally {
    if (previousOverride === undefined) {
      delete process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
    } else {
      process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = previousOverride;
    }
  }
});

test("login fails instead of falling back when browser-assisted device flow is unavailable", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const previousOverride = process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
  process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = "1";

  try {
    const { login } = await importFreshAuthModule(tempHome);
    const originalFetch = global.fetch;
    const requests: string[] = [];

    global.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push(url);

      if (url.endsWith("/auth/device/code")) {
        return jsonResponse({ message: "Authentication required" }, 401);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    try {
      await assert.rejects(
        () =>
          login("https://cloudeval.ai", {
            browserOpener: () => true,
          }),
        /Failed to initiate login: 401/
      );
      assert.deepEqual(requests, ["https://cloudeval.ai/api/v1/auth/device/code"]);
    } finally {
      global.fetch = originalFetch;
    }
  } finally {
    if (previousOverride === undefined) {
      delete process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
    } else {
      process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = previousOverride;
    }
  }
});

test("browser-assisted device flow honors frontend URL override", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const previousStorageOverride = process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
  const previousFrontendUrl = process.env.CLOUDEVAL_FRONTEND_URL;
  process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = "1";
  process.env.CLOUDEVAL_FRONTEND_URL = "http://localhost:3000";

  try {
    const { login } = await importFreshAuthModule(tempHome);
    const originalFetch = global.fetch;
    const originalSetTimeout = global.setTimeout;
    const originalLog = console.log;
    const originalWrite = process.stdout.write.bind(process.stdout);
    const openedUrls: string[] = [];

    global.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/auth/device/code")) {
        return jsonResponse({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://cloudeval.ai/device/login",
          verification_uri_complete:
            "https://cloudeval.ai/device/login?user_code=ABCD-EFGH",
          expires_in: 60,
          interval: 1,
        });
      }

      if (url.endsWith("/auth/device/token")) {
        return jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    global.setTimeout = ((callback: (...args: unknown[]) => void) => {
      queueMicrotask(() => callback());
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;
    console.log = () => {};
    process.stdout.write = (() => true) as typeof process.stdout.write;

    try {
      const token = await login("http://127.0.0.1:8787", {
        browserOpener: (url: string) => {
          openedUrls.push(url);
          return true;
        },
      });
      assert.equal(token, "access-token");
      assert.deepEqual(openedUrls, [
        "http://localhost:3000/device/login?user_code=ABCD-EFGH",
      ]);
    } finally {
      global.fetch = originalFetch;
      global.setTimeout = originalSetTimeout;
      console.log = originalLog;
      process.stdout.write = originalWrite;
    }
  } finally {
    if (previousStorageOverride === undefined) {
      delete process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
    } else {
      process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = previousStorageOverride;
    }
    if (previousFrontendUrl === undefined) {
      delete process.env.CLOUDEVAL_FRONTEND_URL;
    } else {
      process.env.CLOUDEVAL_FRONTEND_URL = previousFrontendUrl;
    }
  }
});

test("browser-assisted device flow rewrites backend localhost verification URLs to CloudEval", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const previousStorageOverride = process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
  const previousFrontendUrl = process.env.CLOUDEVAL_FRONTEND_URL;
  const previousWebUrl = process.env.CLOUDEVAL_WEB_URL;
  const previousDeviceUri = process.env.CLOUDEVAL_DEVICE_VERIFICATION_URI;
  process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = "1";
  delete process.env.CLOUDEVAL_FRONTEND_URL;
  delete process.env.CLOUDEVAL_WEB_URL;
  delete process.env.CLOUDEVAL_DEVICE_VERIFICATION_URI;

  try {
    const { login } = await importFreshAuthModule(tempHome);
    const originalFetch = global.fetch;
    const originalSetTimeout = global.setTimeout;
    const originalLog = console.log;
    const originalWrite = process.stdout.write.bind(process.stdout);
    const openedUrls: string[] = [];

    global.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.endsWith("/auth/device/code")) {
        return jsonResponse({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "http://localhost:3000/device/login",
          verification_uri_complete:
            "http://localhost:3000/device/login?user_code=ABCD-EFGH",
          expires_in: 60,
          interval: 1,
        });
      }

      if (url.endsWith("/auth/device/token")) {
        return jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    };

    global.setTimeout = ((callback: (...args: unknown[]) => void) => {
      queueMicrotask(() => callback());
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;
    console.log = () => {};
    process.stdout.write = (() => true) as typeof process.stdout.write;

    try {
      const token = await login("https://cloudeval.ai", {
        browserOpener: (url: string) => {
          openedUrls.push(url);
          return true;
        },
      });
      assert.equal(token, "access-token");
      assert.deepEqual(openedUrls, [
        "https://cloudeval.ai/device/login?user_code=ABCD-EFGH",
      ]);
    } finally {
      global.fetch = originalFetch;
      global.setTimeout = originalSetTimeout;
      console.log = originalLog;
      process.stdout.write = originalWrite;
    }
  } finally {
    if (previousStorageOverride === undefined) {
      delete process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE;
    } else {
      process.env.CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE = previousStorageOverride;
    }
    if (previousFrontendUrl === undefined) {
      delete process.env.CLOUDEVAL_FRONTEND_URL;
    } else {
      process.env.CLOUDEVAL_FRONTEND_URL = previousFrontendUrl;
    }
    if (previousWebUrl === undefined) {
      delete process.env.CLOUDEVAL_WEB_URL;
    } else {
      process.env.CLOUDEVAL_WEB_URL = previousWebUrl;
    }
    if (previousDeviceUri === undefined) {
      delete process.env.CLOUDEVAL_DEVICE_VERIFICATION_URI;
    } else {
      process.env.CLOUDEVAL_DEVICE_VERIFICATION_URI = previousDeviceUri;
    }
  }
});

test("ensurePlaygroundProject repairs device-created users through quick onboarding", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const { ensurePlaygroundProject } = await importFreshAuthModule(tempHome);
  const originalFetch = global.fetch;
  const requests: Array<{ url: string; method: string; body?: any }> = [];
  let projectFetchCount = 0;

  global.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method || "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ url, method, body });

    if (url.endsWith("/projects/user/user-1")) {
      projectFetchCount += 1;
      return jsonResponse(
        projectFetchCount === 1
          ? [{ id: "cli-project", name: "CLI Project", user_id: "user-1" }]
          : [
              { id: "cli-project", name: "CLI Project", user_id: "user-1" },
              { id: "playground-project", name: "Playground", user_id: "user-1" },
            ]
      );
    }

    if (url.endsWith("/onboard/quick")) {
      assert.equal(method, "POST");
      assert.deepEqual(body, {
        email: "prateek@example.com",
        full_name: "Prateek",
      });
      return jsonResponse(
        {
          user: { id: "user-1", email: "prateek@example.com" },
          playground_project: {
            id: "playground-project",
            name: "Playground",
            user_id: "user-1",
          },
          default_connection: {
            id: "playground-connection",
            name: "Playground",
            user_id: "user-1",
          },
          next_steps: [],
        },
        201
      );
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const project = await ensurePlaygroundProject(
      "http://127.0.0.1:8787",
      "access-token",
      { id: "user-1", email: "prateek@example.com", fullName: "Prateek" }
    );

    assert.equal(project.id, "playground-project");
    assert.equal(project.name, "Playground");
    assert.equal(projectFetchCount, 2);
    assert.equal(requests.some((request) => request.url.endsWith("/projects/")), false);
    assert.equal(requests.some((request) => request.url.endsWith("/onboard/quick")), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("completeOnboarding always runs shared quick onboarding for existing users", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cloudeval-auth-"));
  const { completeOnboarding } = await importFreshAuthModule(tempHome);
  const originalFetch = global.fetch;
  const calls: string[] = [];

  global.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(`${init?.method || "GET"} ${url}`);

    if (url.endsWith("/auth/me")) {
      return jsonResponse({
        id: "user-1",
        email: "prateek@example.com",
        preferences: {},
      });
    }

    if (url.endsWith("/onboard/quick")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.equal(body.email, "prateek@example.com");
      assert.equal(body.full_name, "Prateek");
      return jsonResponse(
        {
          user: { id: "user-1", email: "prateek@example.com" },
          playground_project: {
            id: "playground-project",
            name: "Playground",
            user_id: "user-1",
          },
          default_connection: {
            id: "playground-connection",
            name: "Playground",
            user_id: "user-1",
          },
          next_steps: [],
        },
        201
      );
    }

    if (url.endsWith("/users/user-1")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.equal(body.preferences.onboarding.role, "Engineer");
      assert.equal(body.preferences.onboarding.cloudProvider, "azure");
      assert.equal(typeof body.preferences.onboarding.completedAt, "string");
      return jsonResponse({ id: "user-1" });
    }

    if (url.endsWith("/projects/user/user-1")) {
      return jsonResponse([
        { id: "playground-project", name: "Playground", user_id: "user-1" },
      ]);
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await completeOnboarding("http://127.0.0.1:8787", "access-token", {
      name: "Prateek",
      role: "Engineer",
      teamSize: "1-5",
      goals: ["Understand infrastructure"],
      cloudProvider: "azure",
    });

    const quickIndex = calls.findIndex((call) => call.endsWith("/onboard/quick"));
    const patchIndex = calls.findIndex((call) => call.endsWith("/users/user-1"));
    assert.notEqual(quickIndex, -1);
    assert.notEqual(patchIndex, -1);
    assert.equal(quickIndex < patchIndex, true);
    assert.equal(calls.some((call) => call.endsWith("/projects/")), false);
  } finally {
    global.fetch = originalFetch;
  }
});
