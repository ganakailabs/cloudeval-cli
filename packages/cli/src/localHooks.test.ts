import assert from "node:assert/strict";
import test from "node:test";
import { runLocalHooks } from "./localHooks";

test("local hooks are disabled by default", async () => {
  const warnings = await runLocalHooks({
    event: "cli.command.before",
    config: {},
    profile: "default",
    commandName: "ask",
  });

  assert.deepEqual(warnings, []);
});

test("before hook failure aborts by default", async () => {
  await assert.rejects(
    () =>
      runLocalHooks({
        event: "cli.command.before",
        config: {
          hooks: {
            enabled: true,
            events: {
              "cli.command.before": [
                { id: "fail", command: 'node -e "process.exit(7)"' },
              ],
            },
          },
        },
        profile: "default",
        commandName: "ask",
      }),
    /Hook 'fail' exited with code 7/,
  );
});

test("after hook failure returns warning", async () => {
  const warnings = await runLocalHooks({
    event: "cli.command.after",
    config: {
      hooks: {
        enabled: true,
        events: {
          "cli.command.after": [
            { id: "fail-after", command: 'node -e "process.exit(8)"' },
          ],
        },
      },
    },
    profile: "default",
    commandName: "ask",
  });

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].hookId, "fail-after");
  assert.equal(warnings[0].exitCode, 8);
});

test("noHooks skips configured hooks", async () => {
  const warnings = await runLocalHooks({
    event: "cli.command.before",
    config: {
      hooks: {
        enabled: true,
        events: {
          "cli.command.before": [
            { id: "would-fail", command: 'node -e "process.exit(9)"' },
          ],
        },
      },
    },
    profile: "default",
    commandName: "ask",
    noHooks: true,
  });

  assert.deepEqual(warnings, []);
});

test("hook receives env vars and JSON payload", async () => {
  const command = [
    "node",
    "-e",
    JSON.stringify(
      "const fs=require('fs');" +
        "const p=JSON.parse(fs.readFileSync(process.env.CLOUDEVAL_HOOK_EVENT_FILE,'utf8'));" +
        "if(process.env.CLOUDEVAL_HOOK_EVENT!=='agent_profile.run.before') process.exit(10);" +
        "if(process.env.CLOUDEVAL_PROJECT_ID!=='proj-1') process.exit(11);" +
        "if(process.env.CLOUDEVAL_AGENT_PROFILE_ID!=='cost') process.exit(12);" +
        "if(p.projectId!=='proj-1'||p.agentProfileId!=='cost'||p.threadId!=='thread-1') process.exit(13);",
    ),
  ].join(" ");
  const warnings = await runLocalHooks({
    event: "agent_profile.run.before",
    config: {
      hooks: {
        enabled: true,
        events: {
          "agent_profile.run.before": [{ id: "inspect", command }],
        },
      },
    },
    profile: "default",
    commandName: "agents run",
    projectId: "proj-1",
    agentProfileId: "cost",
    threadId: "thread-1",
  });

  assert.deepEqual(warnings, []);
});
