import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTelemetryUserProperties,
  classifyTelemetryError,
  createCliTelemetry,
  disableDiskRetryCaching,
  resolveTelemetryConnectionString,
  resolveTelemetryEnabled,
  sanitizeTelemetryProperties,
  TELEMETRY_SCHEMA_VERSION,
} from "./telemetry";

test("resolveTelemetryEnabled applies hard disable, env override, config, then default on", () => {
  assert.equal(
    resolveTelemetryEnabled(
      { telemetry: { enabled: true } },
      { CLOUDEVAL_TELEMETRY_DISABLED: "1" } as any,
    ),
    false,
  );
  assert.equal(
    resolveTelemetryEnabled(
      { telemetry: { enabled: true } },
      { CLOUDEVAL_TELEMETRY: "off" } as any,
    ),
    false,
  );
  assert.equal(
    resolveTelemetryEnabled(
      { telemetry: { enabled: false } },
      { CLOUDEVAL_TELEMETRY: "on" } as any,
    ),
    true,
  );
  assert.equal(resolveTelemetryEnabled({ telemetry: { enabled: false } }, {} as any), false);
  assert.equal(resolveTelemetryEnabled({}, {} as any), true);
});

test("resolveTelemetryConnectionString reuses frontend and server environment contracts", () => {
  assert.equal(
    resolveTelemetryConnectionString({
      CLOUDEVAL_APPLICATIONINSIGHTS_CONNECTION_STRING: "cli",
      APPLICATIONINSIGHTS_CONNECTION_STRING: "server",
      NEXT_PUBLIC_APPLICATIONINSIGHTS_CONNECTION_STRING: "frontend",
    } as any),
    "cli",
  );
  assert.equal(
    resolveTelemetryConnectionString({
      APPLICATIONINSIGHTS_CONNECTION_STRING: "server",
      NEXT_PUBLIC_APPLICATIONINSIGHTS_CONNECTION_STRING: "frontend",
    } as any),
    "server",
  );
  assert.equal(
    resolveTelemetryConnectionString({
      NEXT_PUBLIC_APPLICATIONINSIGHTS_CONNECTION_STRING: "frontend",
    } as any),
    "frontend",
  );
});

test("sanitizeTelemetryProperties keeps only the approved CLI telemetry shape", () => {
  const sanitized = sanitizeTelemetryProperties({
    cliVersion: "0.23.0",
    telemetrySchemaVersion: "2",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    requestId: "request-1",
    command: "ask",
    subcommand: "run",
    format: "json",
    interactive: false,
    authMode: "access_key",
    success: true,
    durationMs: 42,
    exitCode: 0,
    email: "user@example.test",
    fullName: "Prateek Singh",
    projectId: "project-secret",
    projectName: "Sensitive Project",
    prompt: "show me my cloud resources",
    output: "assistant response",
    cwd: "/Users/prateek/workspace/repo",
    stack: "Error: no",
    errorMessage: "raw backend error",
    accessToken: "secret",
  });

  assert.deepEqual(sanitized.properties, {
    cliVersion: "0.23.0",
    telemetrySchemaVersion: "2",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    requestId: "request-1",
    command: "ask",
    subcommand: "run",
    format: "json",
    interactive: "false",
    authMode: "access_key",
    success: "true",
    exitCode: "0",
  });
  assert.deepEqual(sanitized.measurements, { durationMs: 42 });
});

test("buildTelemetryUserProperties never emits raw email or names", () => {
  const properties = buildTelemetryUserProperties({
    id: "user-00000000-0000-4000-8000-000000000001",
    email: "person@example.test",
    full_name: "Prateek Kumar Singh",
    firstName: "Prateek",
    lastName: "Singh",
  });
  assert.match(properties.user_hash, /^h_[0-9a-f]{32}$/);
  assert(!Object.values(properties).includes("person@example.test"));
  assert(!Object.values(properties).includes("Prateek Kumar Singh"));
  assert.deepEqual(buildTelemetryUserProperties({ email: "person@example.test", name: "Manu" }), {});
});

test("createCliTelemetry no-ops when disabled or unconfigured", async () => {
  let createdClients = 0;
  const disabled = await createCliTelemetry({
    config: { telemetry: { enabled: false } },
    env: {} as any,
    clientFactory: () => {
      createdClients += 1;
      throw new Error("should not create");
    },
  });
  await disabled.track("cli.command", { command: "status" });

  const unconfigured = await createCliTelemetry({
    config: {},
    env: {} as any,
    clientFactory: () => {
      createdClients += 1;
      throw new Error("should not create");
    },
  });
  await unconfigured.track("cli.command", { command: "status" });

  assert.equal(createdClients, 0);
});

test("createCliTelemetry sends sanitized events and isolates flush errors", async () => {
  const events: Array<{
    name: string;
    properties?: Record<string, string>;
    measurements?: Record<string, number>;
  }> = [];
  const telemetry = await createCliTelemetry({
    config: {},
    env: { CLOUDEVAL_APPLICATIONINSIGHTS_CONNECTION_STRING: "InstrumentationKey=test" } as any,
    commonProperties: {
      cliVersion: "0.23.0",
      telemetrySchemaVersion: TELEMETRY_SCHEMA_VERSION,
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      requestId: "request-1",
      os: "darwin",
    },
    clientFactory: () => ({
      trackEvent: (event) => {
        events.push(event);
      },
      flush: (callback) => {
        callback?.(new Error("network unavailable"));
      },
    }),
  });

  await telemetry.track("cli.command", {
    command: "ask",
    projectId: "project-secret",
    durationMs: 12,
    success: true,
  });
  await telemetry.flush();

  assert.deepEqual(events, [
    {
      name: "cli.command",
      properties: {
        cliVersion: "0.23.0",
        telemetrySchemaVersion: "2",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        requestId: "request-1",
        os: "darwin",
        command: "ask",
        success: "true",
      },
      measurements: { durationMs: 12 },
    },
  ]);
});

test("disableDiskRetryCaching ignores unsupported SDK compatibility methods", () => {
  let calls = 0;
  assert.doesNotThrow(() => {
    disableDiskRetryCaching({
      trackEvent: () => {},
      setUseDiskRetryCaching: () => {
        calls += 1;
        throw new Error("Not implemented");
      },
    });
  });
  assert.equal(calls, 1);
});

test("classifyTelemetryError emits stable categories instead of raw messages", () => {
  assert.equal(
    classifyTelemetryError(new Error("No authentication available. Run cloudeval login.")),
    "auth_unavailable",
  );
  assert.equal(classifyTelemetryError(new Error("Failed to fetch projects: 403")), "forbidden");
  assert.equal(classifyTelemetryError(new Error("cev_test_ak_secret leaked in message")), "error");
});
