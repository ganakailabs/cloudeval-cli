#!/usr/bin/env node
/**
 * Verifies GitHub latest release tag, local package.json, and npm registry agree.
 * Usage:
 *   node scripts/verify-release-channel-sync.mjs
 *   node scripts/verify-release-channel-sync.mjs --ref v0.19.4
 *   node scripts/verify-release-channel-sync.mjs --json
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const REPO = process.env.CLOUDEVAL_RELEASE_REPO ?? "ganakailabs/cloudeval-cli";
const NPM_PACKAGE = process.env.CLOUDEVAL_NPM_PACKAGE ?? "@ganakailabs/cloudeval-cli";
const GITHUB_API = process.env.GITHUB_API_URL ?? "https://api.github.com";

const args = new Set(process.argv.slice(2));
const jsonOutput = args.has("--json");
const refArg = process.argv.find((arg) => arg.startsWith("--ref="))?.slice("--ref=".length)
  ?? (process.argv.includes("--ref") ? process.argv[process.argv.indexOf("--ref") + 1] : undefined);

const readPackageVersion = () => {
  const pkg = JSON.parse(
    readFileSync(path.join(repoRoot, "packages/cli/package.json"), "utf8"),
  );
  return pkg.version;
};

const normalizeTag = (tag) => (tag.startsWith("v") ? tag.slice(1) : tag);

const fetchJson = async (url, headers = {}) => {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "cloudeval-release-sync-check",
      ...headers,
    },
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status} ${response.statusText}) for ${url}`);
  }
  return response.json();
};

const fetchLatestGithubReleaseVersion = async () => {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const release = await fetchJson(`${GITHUB_API}/repos/${REPO}/releases/latest`, {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
  if (!release?.tag_name) {
    throw new Error("GitHub latest release response did not include tag_name.");
  }
  return normalizeTag(release.tag_name);
};

const fetchNpmVersion = async () => {
  const response = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`);
  if (!response.ok) {
    throw new Error(`npm registry lookup failed (${response.status} ${response.statusText}).`);
  }
  const payload = await response.json();
  if (!payload?.version) {
    throw new Error("npm latest response did not include version.");
  }
  return payload.version;
};

const packageVersion = readPackageVersion();
const githubVersion = refArg ? normalizeTag(refArg) : await fetchLatestGithubReleaseVersion();
const npmVersion = await fetchNpmVersion();

const report = {
  repo: REPO,
  npmPackage: NPM_PACKAGE,
  githubVersion,
  npmVersion,
  packageVersion,
  ref: refArg ?? `v${githubVersion}`,
  inSync: githubVersion === npmVersion && githubVersion === packageVersion,
  mismatches: [],
};

if (githubVersion !== npmVersion) {
  report.mismatches.push({
    channel: "github-vs-npm",
    github: githubVersion,
    npm: npmVersion,
  });
}
if (githubVersion !== packageVersion) {
  report.mismatches.push({
    channel: "github-vs-package",
    github: githubVersion,
    package: packageVersion,
  });
}
if (npmVersion !== packageVersion) {
  report.mismatches.push({
    channel: "npm-vs-package",
    npm: npmVersion,
    package: packageVersion,
  });
}

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`GitHub latest release: v${githubVersion}`);
  console.log(`npm ${NPM_PACKAGE}:     ${npmVersion}`);
  console.log(`packages/cli package:  ${packageVersion}`);
  if (report.inSync) {
    console.log("Status: in sync");
  } else {
    console.log("Status: OUT OF SYNC");
    for (const mismatch of report.mismatches) {
      console.log(`- ${mismatch.channel}: ${JSON.stringify(mismatch)}`);
    }
  }
}

assert.equal(
  report.inSync,
  true,
  `Release channels are out of sync: ${JSON.stringify(report.mismatches)}`,
);
