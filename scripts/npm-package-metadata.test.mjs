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
  assert.equal(pkg.license, "SEE LICENSE IN LICENSE");
  assert.deepEqual(pkg.publishConfig, { access: "public" });
  assert.equal(pkg.scripts.prepack, "node ../../scripts/prepare-npm-package.mjs");

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
});

test("semantic-release publishes the CLI package to npm before GitHub assets", () => {
  const releaseConfig = readJson(".releaserc.json");
  const rootPkg = readJson("package.json");
  const plugins = releaseConfig.plugins;
  const pluginNames = plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));

  assert.ok(pluginNames.includes("@semantic-release/npm"));
  assert.ok(
    pluginNames.indexOf("./scripts/sync-release-version.cjs") <
      pluginNames.indexOf("@semantic-release/npm"),
    "release version sync runs before npm publish",
  );
  assert.ok(
    pluginNames.indexOf("@semantic-release/npm") < pluginNames.indexOf("@semantic-release/github"),
    "npm publish runs before GitHub release publication",
  );

  const npmPlugin = plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === "@semantic-release/npm",
  );
  assert.deepEqual(npmPlugin?.[1], {
    pkgRoot: "packages/cli",
    tarballDir: "packages/cli/dist",
  });

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

  assert.match(rootPkg.devDependencies["@semantic-release/npm"], /^\^13\./);
});

test("semantic-release workflow is configured for npm trusted publishing", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github/workflows/semantic-release.yml"),
    "utf8",
  );

  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /node-version:\s*22\.14\.0/);
  assert.match(workflow, /npm install -g npm@\^11\.10\.0/);
  assert.doesNotMatch(workflow, /NPM_TOKEN/);
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
