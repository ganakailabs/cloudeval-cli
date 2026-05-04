import assert from "node:assert/strict";
import test from "node:test";
import { buildMcpClientSetup } from "./mcpSetupCommand.js";

test("buildMcpClientSetup creates Codex registration command", () => {
  const setup = buildMcpClientSetup({
    client: "codex",
    command: "/usr/local/bin/cloudeval",
    toolset: "readonly",
  });

  assert.equal(setup.client, "codex");
  assert.equal(setup.transport, "stdio");
  assert.deepEqual(setup.server.args, ["mcp", "serve", "--toolset", "readonly"]);
  assert.equal(
    setup.instructions[0],
    "codex mcp add cloudeval -- /usr/local/bin/cloudeval mcp serve --toolset readonly"
  );
});

test("buildMcpClientSetup creates Claude and Cursor mcpServers config", () => {
  const claude = buildMcpClientSetup({
    client: "claude",
    command: "cloudeval",
    toolset: "reports",
  });
  assert.deepEqual(claude.config, {
    mcpServers: {
      cloudeval: {
        command: "cloudeval",
        args: ["mcp", "serve", "--toolset", "reports"],
      },
    },
  });

  const cursor = buildMcpClientSetup({
    client: "cursor",
    command: "cloudeval",
    toolset: "billing",
  });
  assert.deepEqual(cursor.config, {
    mcpServers: {
      cloudeval: {
        command: "cloudeval",
        args: ["mcp", "serve", "--toolset", "billing"],
      },
    },
  });
});
