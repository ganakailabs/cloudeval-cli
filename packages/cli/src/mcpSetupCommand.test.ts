import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMcpClientSetup,
  formatMcpClientSetupText,
} from "./mcpSetupCommand.js";

test("buildMcpClientSetup creates Codex registration command", () => {
  const setup = buildMcpClientSetup({
    client: "codex",
    command: "/usr/local/bin/cloudeval",
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

test("buildMcpClientSetup creates generic mcpServers config for other MCP clients", () => {
  const setup = buildMcpClientSetup({
    client: "generic",
    command: "cloudeval",
    toolset: "readonly",
  });

  assert.equal(setup.client, "generic");
  assert.equal(setup.transport, "stdio");
  assert.equal(setup.configPath, undefined);
  assert.deepEqual(setup.config, {
    mcpServers: {
      cloudeval: {
        command: "cloudeval",
        args: ["mcp", "serve", "--toolset", "readonly"],
      },
    },
  });
  assert.match(setup.instructions[0], /Copy the shown mcpServers\.cloudeval entry/);
});

test("buildMcpClientSetup supports the IDE toolset", () => {
  const setup = buildMcpClientSetup({
    client: "vscode",
    command: "cloudeval",
    toolset: "ide",
  });

  assert.deepEqual(setup.server.args, ["mcp", "serve", "--toolset", "ide"]);
  assert.deepEqual(setup.config, {
    servers: {
      cloudeval: {
        type: "stdio",
        command: "cloudeval",
        args: ["mcp", "serve", "--toolset", "ide"],
      },
    },
  });
});

test("formatMcpClientSetupText renders a concise human summary for written config", () => {
  const setup = buildMcpClientSetup({
    client: "claude",
    command: "/usr/local/bin/cloudeval",
    toolset: "readonly",
    configPath: "/tmp/claude_desktop_config.json",
  });

  const text = formatMcpClientSetupText(setup, {
    dryRun: false,
    writtenPath: "/tmp/claude_desktop_config.json",
  });

  assert.match(text, /^CloudEval MCP setup\n/);
  assert.match(text, /Client: Claude/);
  assert.match(text, /Status: wrote config/);
  assert.match(text, /Config: \/tmp\/claude_desktop_config\.json/);
  assert.match(text, /Command: \/usr\/local\/bin\/cloudeval mcp serve --toolset readonly/);
  assert.match(text, /Restart Claude Desktop to load the CloudEval MCP server/);
  assert.doesNotMatch(text, /Merge the shown/);
  assert.doesNotMatch(text, /^Field\s+Value/m);
});

test("formatMcpClientSetupText renders dry-run config without field tables", () => {
  const setup = buildMcpClientSetup({
    client: "vscode",
    command: "/usr/local/bin/cloudeval",
    toolset: "readonly",
    configPath: "/tmp/.vscode/mcp.json",
  });

  const text = formatMcpClientSetupText(setup, {
    dryRun: true,
  });

  assert.match(text, /Status: dry run, no files changed/);
  assert.match(text, /Config to add:/);
  assert.match(text, /"servers"/);
  assert.doesNotMatch(text, /^Field\s+Value/m);
});
