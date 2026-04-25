#!/usr/bin/env node
import http from "node:http";
import { randomUUID } from "node:crypto";

const config = {
  host: process.env.MOCK_HOST ?? "127.0.0.1",
  port: Number(process.env.MOCK_PORT ?? "0"),
  onboardingCompleted: process.env.MOCK_ONBOARDING_COMPLETED !== "0",
  includePlayground: process.env.MOCK_INCLUDE_PLAYGROUND !== "0",
  healthy: process.env.MOCK_HEALTHY !== "0",
  devicePendingCount: Number(process.env.MOCK_DEVICE_PENDING_COUNT ?? "1"),
  legacyDeviceOnly: process.env.MOCK_LEGACY_DEVICE_ONLY === "1",
  pkceStartStatus: Number(process.env.MOCK_PKCE_START_STATUS ?? "200"),
  slowStreamDelayMs: Number(process.env.MOCK_SLOW_STREAM_DELAY_MS ?? "750"),
  logRequests: process.env.MOCK_LOG_REQUESTS === "1",
  acceptAnyBearer: process.env.MOCK_ACCEPT_ANY_BEARER !== "0",
};

const state = {
  usersById: new Map(),
  usersByEmail: new Map(),
  accessTokens: new Map(),
  refreshTokens: new Map(),
  authCodes: new Map(),
  deviceCodes: new Map(),
  logoutEvents: [],
  lastStreamRequest: null,
  lastQuickOnboard: null,
  lastOnboardingPatch: null,
};

const json = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
};

const parseBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getAuthToken = (req) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return undefined;
  }
  return authHeader.slice("Bearer ".length);
};

const buildProjects = () => {
  if (config.includePlayground) {
    return [
      {
        id: "project-playground",
        name: "Playground",
        cloud_provider: "azure",
        user_id: "user-default",
      },
      {
        id: "project-prod",
        name: "Production",
        cloud_provider: "aws",
        user_id: "user-default",
      },
    ];
  }

  return [
    {
      id: "project-alpha",
      name: "Alpha",
      cloud_provider: "azure",
      user_id: "user-default",
    },
    {
      id: "project-beta",
      name: "Beta",
      cloud_provider: "gcp",
      user_id: "user-default",
    },
  ];
};

const ensureUser = (email = "cli@example.com") => {
  const existingUserId = state.usersByEmail.get(email);
  if (existingUserId) {
    return state.usersById.get(existingUserId);
  }

  const userId = `user-${randomUUID()}`;
  const user = {
    id: userId,
    email,
    preferences: config.onboardingCompleted
      ? {
          onboarding: {
            completedAt: Date.now(),
          },
        }
      : {},
    projects: buildProjects().map((project) => ({
      ...project,
      user_id: userId,
    })),
  };

  state.usersById.set(userId, user);
  state.usersByEmail.set(email, userId);
  return user;
};

const issueTokens = (user) => {
  const accessToken = `access-${randomUUID()}`;
  const refreshToken = `refresh-${randomUUID()}`;
  const sessionId = `sess-${randomUUID()}`;
  const accountId = `acct-${user.id}`;

  state.accessTokens.set(accessToken, {
    userId: user.id,
    email: user.email,
    sessionId,
    accountId,
  });
  state.refreshTokens.set(refreshToken, {
    userId: user.id,
    revoked: false,
    sessionId,
    accountId,
  });

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: 3600,
    session_id: sessionId,
    account_id: accountId,
  };
};

const getUserFromRequest = (req) => {
  const token = getAuthToken(req);
  if (!token) {
    return undefined;
  }

  const session =
    state.accessTokens.get(token) ??
    (config.acceptAnyBearer
      ? {
          userId: ensureUser().id,
        }
      : undefined);
  if (!session) {
    return undefined;
  }

  return state.usersById.get(session.userId);
};

const sendSse = (res, event) => {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
};

const streamChat = async (req, res) => {
  const token = getAuthToken(req);
  if (!token) {
    return json(res, 401, { message: "Missing bearer token" });
  }

  const session =
    state.accessTokens.get(token) ??
    (config.acceptAnyBearer
      ? {
          userId: ensureUser().id,
          email: ensureUser().email,
          sessionId: "session-api-key",
          accountId: "account-api-key",
        }
      : undefined);
  if (!session) {
    return json(res, 401, { message: "Invalid access token" });
  }

  const body = await parseBody(req);
  state.lastStreamRequest = body;
  const message = String(body.message ?? "");
  const threadId = String(body.thread_id ?? randomUUID());

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  sendSse(res, {
    type: "metadata",
    thread_id: threadId,
    trace_id: `trace-${randomUUID()}`,
  });

  if (message.includes("error")) {
    sendSse(res, {
      type: "error",
      node: "generate_response",
      message: "Mock backend error",
      status: "error",
    });
    res.end("data: [DONE]\n\n");
    return;
  }

  sendSse(res, {
    type: "thinking",
    node: "plan_response",
    description: "Planning response",
    status: "streaming",
  });

  if (message.includes("followup")) {
    sendSse(res, {
      type: "responding",
      node: "generate_response",
      content: "Primary answer",
      status: "completed",
    });
    sendSse(res, {
      type: "responding",
      node: "generate_follow_up",
      content: "What should we check next?;Do you want logs?",
      status: "completed",
    });
    res.end("data: [DONE]\n\n");
    return;
  }

  const projectName = body.project?.name ?? "unknown-project";
  sendSse(res, {
    type: "responding",
    node: "generate_response",
    content: `Mock response for "${message}" in ${projectName}.`,
    status: "streaming",
  });
  if (message.includes("slow")) {
    await wait(config.slowStreamDelayMs);
  }
  sendSse(res, {
    type: "responding",
    node: "generate_response",
    content: " Complete.",
    status: "completed",
  });
  res.end("data: [DONE]\n\n");
};

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? "/", `http://${config.host}:${config.port || 80}`);
  const pathname = requestUrl.pathname;

  if (config.logRequests) {
    console.error(`[mock] ${req.method} ${pathname}`);
  }

  if (pathname === "/authorize" && req.method === "GET") {
    const redirectUri = requestUrl.searchParams.get("redirect_uri");
    const stateParam = requestUrl.searchParams.get("state") ?? "";
    const email = requestUrl.searchParams.get("email") ?? "cli@example.com";

    if (!redirectUri) {
      return json(res, 400, { message: "Missing redirect_uri" });
    }

    const code = `code-${randomUUID()}`;
    state.authCodes.set(code, {
      state: stateParam,
      email,
    });

    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set("code", code);
    redirectUrl.searchParams.set("state", stateParam);
    res.statusCode = 302;
    res.setHeader("Location", redirectUrl.toString());
    res.end();
    return;
  }

  if (pathname === "/api/v1/chat/health" && req.method === "GET") {
    return json(res, config.healthy ? 200 : 503, {
      status: config.healthy ? "healthy" : "unhealthy",
    });
  }

  if (pathname === "/api/v1/chat/stream" && req.method === "POST") {
    return streamChat(req, res);
  }

  if (pathname === "/api/v1/auth/cli/login/start" && req.method === "POST") {
    if (config.pkceStartStatus !== 200) {
      return json(res, config.pkceStartStatus, {
        message: "PKCE login unavailable",
      });
    }

    const body = await parseBody(req);
    const redirectUri = body.redirect_uri;
    const stateParam = body.state;

    return json(res, 200, {
      authorization_url: `http://${config.host}:${server.address().port}/authorize?redirect_uri=${encodeURIComponent(
        redirectUri
      )}&state=${encodeURIComponent(stateParam)}`,
    });
  }

  if (pathname === "/api/v1/auth/token" && req.method === "POST") {
    const body = await parseBody(req);
    const codeRecord = state.authCodes.get(body.code);
    if (!codeRecord || codeRecord.state !== body.state) {
      return json(res, 400, { message: "Invalid auth code or state" });
    }

    const user = ensureUser(codeRecord.email);
    state.authCodes.delete(body.code);
    return json(res, 200, issueTokens(user));
  }

  if (pathname === "/api/v1/auth/device/code" && req.method === "POST") {
    if (config.legacyDeviceOnly) {
      return json(res, 404, { message: "Use legacy device endpoint" });
    }
    const deviceCode = `device-${randomUUID()}`;
    state.deviceCodes.set(deviceCode, {
      email: "cli@example.com",
      pollsRemaining: config.devicePendingCount,
    });

    return json(res, 200, {
      device_code: deviceCode,
      user_code: "ABCD-EFGH",
      verification_uri: `http://${config.host}:${server.address().port}/device`,
      verification_uri_complete: `http://${config.host}:${server.address().port}/device?code=${deviceCode}`,
      expires_in: 300,
      interval: 1,
    });
  }

  if (pathname === "/api/v1/device/code" && req.method === "POST") {
    const deviceCode = `device-${randomUUID()}`;
    state.deviceCodes.set(deviceCode, {
      email: "cli@example.com",
      pollsRemaining: config.devicePendingCount,
    });

    return json(res, 200, {
      device_code: deviceCode,
      user_code: "ABCD-EFGH",
      verification_uri: `http://${config.host}:${server.address().port}/device`,
      verification_uri_complete: `http://${config.host}:${server.address().port}/device?code=${deviceCode}`,
      expires_in: 300,
      interval: 1,
    });
  }

  if (pathname === "/api/v1/auth/device/token" && req.method === "POST") {
    if (config.legacyDeviceOnly) {
      return json(res, 404, { message: "Use legacy device endpoint" });
    }
    const body = await parseBody(req);
    const record = state.deviceCodes.get(body.device_code);

    if (!record) {
      return json(res, 400, { error: "invalid_device_code" });
    }

    if (record.pollsRemaining > 0) {
      record.pollsRemaining -= 1;
      return json(res, 200, { error: "authorization_pending" });
    }

    const user = ensureUser(record.email);
    state.deviceCodes.delete(body.device_code);
    return json(res, 200, issueTokens(user));
  }

  if (pathname === "/api/v1/device/token" && req.method === "POST") {
    const body = await parseBody(req);
    const record = state.deviceCodes.get(body.device_code);

    if (!record) {
      return json(res, 400, { error: "invalid_device_code" });
    }

    if (record.pollsRemaining > 0) {
      record.pollsRemaining -= 1;
      return json(res, 200, { error: "authorization_pending" });
    }

    const user = ensureUser(record.email);
    state.deviceCodes.delete(body.device_code);
    return json(res, 200, issueTokens(user));
  }

  if (pathname === "/api/v1/auth/refresh" && req.method === "POST") {
    const body = await parseBody(req);
    const session = state.refreshTokens.get(body.refresh_token);

    if (!session || session.revoked) {
      return json(res, 401, { message: "Invalid refresh token" });
    }

    session.revoked = true;
    const user = state.usersById.get(session.userId);
    return json(res, 200, issueTokens(user));
  }

  if (
    (pathname === "/api/v1/auth/logout" || pathname === "/api/v1/auth/logout-all") &&
    req.method === "POST"
  ) {
    const body = await parseBody(req);
    const refreshToken = body.refresh_token;
    const session = refreshToken ? state.refreshTokens.get(refreshToken) : undefined;
    if (session) {
      session.revoked = true;
    }
    state.logoutEvents.push({
      path: pathname,
      refreshToken,
      sessionId: body.session_id,
    });
    return json(res, 200, { revoked: true });
  }

  if (pathname === "/api/v1/auth/me" && req.method === "GET") {
    const user = getUserFromRequest(req);
    if (!user) {
      return json(res, 401, { message: "Unauthorized" });
    }
    return json(res, 200, {
      id: user.id,
      email: user.email,
      preferences: user.preferences ?? {},
    });
  }

  if (pathname === "/api/v1/user/email" && req.method === "POST") {
    const body = await parseBody(req);
    const user = ensureUser(body.email);
    return json(res, 200, user);
  }

  if (pathname.startsWith("/api/v1/projects/user/") && req.method === "GET") {
    const userId = pathname.split("/").pop();
    const user = state.usersById.get(userId);
    if (!user) {
      return json(res, 404, { message: "User not found" });
    }
    return json(res, 200, user.projects);
  }

  if (pathname === "/api/v1/onboard/quick" && req.method === "POST") {
    const body = await parseBody(req);
    state.lastQuickOnboard = body;
    const user = ensureUser(body.email);
    user.email = body.email ?? user.email;
    user.full_name = body.full_name ?? "CLI User";
    return json(res, 200, { user });
  }

  if (pathname.startsWith("/api/v1/users/") && req.method === "PATCH") {
    const userId = pathname.split("/").pop();
    const user = state.usersById.get(userId);
    if (!user) {
      return json(res, 404, { message: "User not found" });
    }

    const body = await parseBody(req);
    state.lastOnboardingPatch = body;
    user.preferences = {
      ...(user.preferences ?? {}),
      ...(body.preferences ?? {}),
    };

    return json(res, 200, { user });
  }

  if (pathname === "/api/v1/__mock/state" && req.method === "GET") {
    return json(res, 200, {
      logoutEvents: state.logoutEvents,
      lastStreamRequest: state.lastStreamRequest,
      lastQuickOnboard: state.lastQuickOnboard,
      lastOnboardingPatch: state.lastOnboardingPatch,
    });
  }

  if (pathname === "/device" && req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Device login page");
    return;
  }

  json(res, 404, {
    message: "Not found",
    path: pathname,
    method: req.method,
  });
});

server.listen(config.port, config.host, () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind mock backend");
  }

  const baseUrl = `http://${config.host}:${address.port}`;
  console.log(`mock-backend-ready ${baseUrl}`);
});
