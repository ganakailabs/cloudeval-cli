import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const readJson = (relativePath) =>
  JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));

test("CLI package is publishable to npm with required public artifacts", () => {
  const pkg = readJson("packages/cli/package.json");

  assert.equal(pkg.name, "@ganakailabs/cloudeval-cli");
  assert.equal(pkg.private, undefined);
  assert.equal(
    pkg.description,
    "CloudEval CLI for cloud architecture, cost, report, automation, and MCP workflows.",
  );
  assert.equal(pkg.author, "Ganak AI Labs (https://cloudeval.ai)");
  assert.equal(pkg.license, "SEE LICENSE IN LICENSE");
  assert.deepEqual(pkg.engines, { node: ">=20" });
  assert.deepEqual(pkg.publishConfig, { access: "public" });
  assert.equal(pkg.scripts.prepack, "node ../../scripts/prepare-npm-package.mjs");
  assert.equal(pkg.homepage, "https://docs.cloudeval.ai/reference/cli-overview");
  assert.equal(pkg.repository.url, "git+https://github.com/ganakailabs/cloudeval-cli.git");
  assert.equal(pkg.repository.directory, "packages/cli");
  assert.equal(pkg.bugs.url, "https://github.com/ganakailabs/cloudeval-cli/issues");

  for (const keyword of [
    "cloudeval",
    "azure",
    "cli",
    "mcp",
    "agents",
    "automation",
    "iac",
    "well-architected",
    "cost",
    "architecture",
  ]) {
    assert.ok(pkg.keywords.includes(keyword), `${keyword} keyword is included`);
  }

  for (const binName of ["cloudeval", "cloud", "eva"]) {
    assert.equal(pkg.bin[binName], "dist/cli.js");
  }

  for (const file of [
    "dist",
    "README.md",
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
    "sbom.spdx.json",
  ]) {
    assert.ok(pkg.files.includes(file), `${file} is included in npm package files`);
  }
});

test("monorepo root refuses accidental npm publish attempts", () => {
  const pkg = readJson("package.json");
  const guardScript = readFileSync(
    path.join(repoRoot, "scripts/prevent-root-npm-publish.mjs"),
    "utf8",
  );

  assert.equal(pkg.private, true);
  assert.equal(pkg.scripts.prepublishOnly, "node scripts/prevent-root-npm-publish.mjs");
  assert.match(guardScript, /packages\/cli/);
  assert.match(guardScript, /@ganakailabs\/cloudeval-cli/);
  assert.match(guardScript, /npm publish --access public/);
});

test("public install docs use the scoped npm package name", () => {
  const rootReadme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const cliReadme = readFileSync(path.join(repoRoot, "packages/cli/README.md"), "utf8");
  const releaseSmokeDocs = readFileSync(
    path.join(repoRoot, "docs/release-smoke-tests.md"),
    "utf8",
  );

  for (const content of [rootReadme, cliReadme, releaseSmokeDocs]) {
    assert.match(content, /@ganakailabs\/cloudeval-cli/);
  }
  assert.doesNotMatch(rootReadme, /npm install -g cloudeval-cli\b/);
  assert.doesNotMatch(cliReadme, /npm install -g cloudeval-cli\b/);
  assert.match(cliReadme, /https:\/\/cloudeval\.ai/);
  assert.match(cliReadme, /https:\/\/docs\.cloudeval\.ai\/reference\/cli-overview/);
  assert.match(cliReadme, /https:\/\/github\.com\/ganakailabs\/cloudeval-cli\/issues/);
  assert.match(cliReadme, /docs\/assets\/images\/cli\/tui-chat\.png/);
  assert.match(cliReadme, /cloudeval agents run cost --project <project-id> --format json/);
  assert.match(cliReadme, /cloudeval uninstall --yes --remove-config/);
  assert.match(cliReadme, /npm uninstall -g @ganakailabs\/cloudeval-cli/);
  assert.match(cliReadme, /CloudEval CLI License/);
  assert.match(cliReadme, /THIRD_PARTY_NOTICES\.md/);
  assert.match(cliReadme, /sbom\.spdx\.json/);
});

test("semantic-release owns GitHub release assets while npm publishing stays manual", () => {
  const releaseConfig = readJson(".releaserc.json");
  const plugins = releaseConfig.plugins;
  const pluginNames = plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));

  assert.ok(!pluginNames.includes("@semantic-release/npm"));
  assert.ok(
    pluginNames.indexOf("./scripts/sync-release-version.cjs") <
      pluginNames.indexOf("@semantic-release/git"),
    "release version sync runs before release commit",
  );
  assert.ok(
    pluginNames.indexOf("@semantic-release/git") < pluginNames.indexOf("@semantic-release/github"),
    "release commit runs before GitHub release publication",
  );

  const gitPlugin = plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === "@semantic-release/git",
  );
  for (const asset of [
    "package.json",
    "packages/cli/package.json",
    "packages/cli/src/version.ts",
    "THIRD_PARTY_NOTICES.md",
    "sbom.spdx.json",
  ]) {
    assert.ok(gitPlugin?.[1]?.assets?.includes(asset), `${asset} is committed by release`);
  }
});

test("semantic-release workflow does not require npm publishing credentials", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github/workflows/semantic-release.yml"),
    "utf8",
  );
  const runner = readFileSync(path.join(repoRoot, "scripts/run-semantic-release.mjs"), "utf8");

  assert.doesNotMatch(workflow, /id-token:\s*write/);
  assert.doesNotMatch(workflow, /npm install -g npm@\^11\.10\.0/);
  assert.match(workflow, /node scripts\/run-semantic-release\.mjs/);
  assert.doesNotMatch(workflow, /cycjimmy\/semantic-release-action/);
  assert.doesNotMatch(workflow, /NPM_TOKEN/);
  assert.match(runner, /semantic-release/);
  assert.match(runner, /GITHUB_OUTPUT/);
});

test("semantic-release binary uploads avoid cross-platform asset races", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github/workflows/semantic-release.yml"),
    "utf8",
  );

  assert.match(workflow, /shopt -s nullglob/);
  assert.match(workflow, /timeout-minutes:\s*10/);
  assert.match(workflow, /files=\(packages\/cli\/dist\/bin\/cloudeval-\$\{\{ matrix\.platform \}\}-\$\{\{ matrix\.arch \}\}\*\)/);
  assert.match(workflow, /matrix\.platform \}\}-\$\{\{ matrix\.arch \}\}" = "linux-x64"/);
  assert.match(workflow, /packages\/cli\/dist\/bin\/LICENSE\*/);
  assert.doesNotMatch(workflow, /node packages\/cli\/scripts\/alias-executables\.js/);
  assert.doesNotMatch(workflow, /gh release upload "\$RELEASE_TAG" packages\/cli\/dist\/bin\/\*/);
});

test("manual npm publish workflow uses trusted publishing without tokens", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github/workflows/npm-publish.yml"),
    "utf8",
  );

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /node-version:\s*22\.14\.0/);
  assert.match(workflow, /npm install -g npm@\^11\.10\.0/);
  assert.match(workflow, /npm publish --access public/);
  assert.doesNotMatch(workflow, /NPM_TOKEN/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
});

test("release helper scripts can spawn pnpm on Windows runners", () => {
  for (const script of [
    "scripts/generate-license-artifacts.mjs",
    "scripts/license-audit.mjs",
    "scripts/prepare-npm-package.mjs",
  ]) {
    const content = readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /const useShell = process\.platform === "win32"/);
    assert.match(content, /execFileSync\("pnpm",/);
    assert.match(content, /shell: useShell/);
  }
});
