import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const bin = process.env.CLOUDEVAL_CLI_BIN || "./dist/bin/cloudeval";
const env = { ...process.env };
delete env.CLOUDEVAL_BASE_URL;

const runCli = (args: string[], timeout = 60_000) => {
  const result = spawnSync(bin, args, {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout,
  });
  return {
    code: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
};

const assertOk = (name: string, result: ReturnType<typeof runCli>) => {
  assert.equal(
    result.code,
    0,
    `${name} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
};

const isMissingAuth = (result: ReturnType<typeof runCli>) =>
  /No authentication available|Run 'cloudeval login'|Run `cloudeval login`|Authentication required/i.test(
    `${result.stdout}\n${result.stderr}`
  );

const isDeviceMutationNotDeployed = (result: ReturnType<typeof runCli>) =>
  /Device token not authorized for this endpoint/i.test(
    `${result.stdout}\n${result.stderr}`
  );

const parseEnvelope = (name: string, result: ReturnType<typeof runCli>) => {
  assertOk(name, result);
  return JSON.parse(result.stdout);
};

const selectProject = (projects: any[]) => {
  const project = projects.find((item) => item.name === "Playground") ?? projects[0];
  assert(project?.id, "No project is available in the live backend account.");
  return project;
};

test("live non-interactive CLI commands work against the authenticated backend", async (t) => {
  const auth = runCli(["auth", "status"]);
  assertOk("auth status", auth);
  assert.match(auth.stdout, /Authenticated: yes/);
  assert.doesNotMatch(auth.stdout, /CLI API URL: http:\/\/127\.0\.0\.1/);

  const projectsResult = runCli([
    "projects",
    "list",
    "--format",
    "json",
    "--non-interactive",
    "--no-open",
  ]);
  if (isMissingAuth(projectsResult)) {
    t.skip(
      "No usable local Cloudeval live session. Run `./packages/cli/dist/bin/cloudeval login` and rerun this live test."
    );
    return;
  }
  const projects = parseEnvelope("projects list", projectsResult).data;
  const project = selectProject(projects);

  parseEnvelope("projects get", runCli([
    "projects",
    "get",
    project.id,
    "--format",
    "json",
    "--non-interactive",
    "--no-open",
  ]));

  if (process.env.CLOUDEVAL_LIVE_ALLOW_MUTATION === "1") {
    const createResult = runCli([
      "projects",
      "create",
      "--template-url",
      "https://github.com/Azure/azure-quickstart-templates/blob/master/quickstarts/microsoft.compute/vm-simple-linux/azuredeploy.json",
      "--name",
      `CLI Live Smoke ${new Date().toISOString()}`,
      "--description",
      "Temporary CLI live backend smoke test project",
      "--provider",
      "azure",
      "--format",
      "json",
      "--non-interactive",
      "--no-open",
    ]);
    if (
      isDeviceMutationNotDeployed(createResult) &&
      process.env.CLOUDEVAL_LIVE_REQUIRE_MUTATION !== "1"
    ) {
      t.diagnostic(
        "Skipping live project creation because the cloud backend has not deployed CLI device-token mutation support yet. Set CLOUDEVAL_LIVE_REQUIRE_MUTATION=1 to fail instead."
      );
    } else {
      parseEnvelope("projects create", createResult);
    }
  } else {
    t.diagnostic("Skipping live project creation. Set CLOUDEVAL_LIVE_ALLOW_MUTATION=1 to include it.");
  }

  const connections = parseEnvelope("connections list", runCli([
    "connections",
    "list",
    "--format",
    "json",
    "--non-interactive",
    "--no-open",
  ])).data;
  if (connections[0]?.id) {
    parseEnvelope("connections get", runCli([
      "connections",
      "get",
      connections[0].id,
      "--format",
      "json",
      "--non-interactive",
      "--no-open",
    ]));
  }

  for (const [name, args] of [
    ["billing summary", ["billing", "summary"]],
    ["billing plans", ["billing", "plans"]],
    ["billing usage", ["billing", "usage", "--range", "7d"]],
    ["billing ledger", ["billing", "ledger", "--limit", "5"]],
    ["billing invoices", ["billing", "invoices", "--limit", "5"]],
    ["billing topups", ["billing", "topups"]],
    ["billing notifications", ["billing", "notifications", "--limit", "5"]],
    ["credits", ["credits"]],
  ] as const) {
    parseEnvelope(name, runCli([...args, "--format", "json", "--non-interactive", "--no-open"]));
  }

  for (const [name, args] of [
    ["open project", ["open", "project", project.id, "--view", "both", "--layout", "dependency"]],
    ["open reports", ["open", "reports", "--project", project.id, "--tab", "overview"]],
    ["open billing", ["open", "billing", "--tab", "usage"]],
  ] as const) {
    const result = runCli([...args, "--print-url", "--no-open"]);
    assertOk(name, result);
    assert.match(result.stdout, /^https?:\/\//);
  }

  parseEnvelope("reports list", runCli([
    "reports",
    "list",
    "--project",
    project.id,
    "--kind",
    "all",
    "--format",
    "json",
    "--non-interactive",
    "--no-open",
  ]));
  parseEnvelope("reports cost", runCli([
    "reports",
    "cost",
    "--project",
    project.id,
    "--format",
    "json",
    "--parsed",
    "--non-interactive",
    "--no-open",
  ]));
  parseEnvelope("reports waf", runCli([
    "reports",
    "waf",
    "--project",
    project.id,
    "--format",
    "json",
    "--parsed",
    "--non-interactive",
    "--no-open",
  ]));
  parseEnvelope("reports rules", runCli([
    "reports",
    "rules",
    "--project",
    project.id,
    "--format",
    "json",
    "--non-interactive",
    "--no-open",
  ]));

  const answer = parseEnvelope("ask", runCli([
    "ask",
    "Say hello in five words or fewer.",
    "--project",
    project.id,
    "--model",
    "gpt-5-nano",
    "--format",
    "json",
    "--non-interactive",
    "--print-url",
    "--no-open",
  ], 90_000));
  assert.match(answer.data.response, /\S/);
  assert.doesNotMatch(answer.data.response, /upstream access issue/i);
});
