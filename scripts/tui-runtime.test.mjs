import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = process.env.CLOUDEVAL_TUI_PACKAGE_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/cli");
const cliRequire = createRequire(path.join(packageRoot, "package.json"));
const plugins = ["ink-scroll-view", "ink-syntax-highlight", "ink-text-input"];

test("installed TUI components share the CLI React and Ink runtime", () => {
  for (const name of ["ink", ...plugins]) {
    const pluginRequire = createRequire(cliRequire.resolve(name));
    assert.equal(pluginRequire.resolve("react"), cliRequire.resolve("react"),
      `${name} must use the same React instance as the CLI`);
    if (name !== "ink") {
      assert.equal(pluginRequire.resolve("ink"), cliRequire.resolve("ink"),
        `${name} must use the same Ink renderer as the CLI`);
    }
  }
});

test("installed scroll and syntax components render with real React hooks", async () => {
  const load = (name) => import(pathToFileURL(cliRequire.resolve(name)).href);
  const [{ default: React }, { render, Text }, { ScrollView }, { default: SyntaxHighlight }] =
    await Promise.all([load("react"), load("ink"), load("ink-scroll-view"), load("ink-syntax-highlight")]);
  const output = new PassThrough();
  output.columns = 100;
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString(); });
  const instance = render(
    React.createElement(ScrollView, { height: 6, width: 100 },
      React.createElement(Text, null, "TUI runtime ready"),
      React.createElement(SyntaxHighlight, { code: "const ready = true;", language: "javascript" })),
    { stdout: output, stderr: output, stdin: new PassThrough(), exitOnCtrlC: false, patchConsole: false },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Ink flushes its final frame on unmount in CI/non-interactive environments.
    instance.unmount();
    assert.match(text, /TUI runtime ready/);
    assert.doesNotMatch(text, /Invalid hook call|Cannot read properties of null|ERROR/);
  } finally {
    instance.cleanup();
  }
});
