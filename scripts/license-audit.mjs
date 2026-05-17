#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const useShell = process.platform === "win32";

const requiredFiles = [
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
];

const deniedLicensePatterns = [
  /\bAGPL\b/i,
  /\bGPL\b/i,
  /\bLGPL\b/i,
  /\bMPL\b/i,
  /\bEPL\b/i,
  /\bCDDL\b/i,
  /\bSSPL\b/i,
  /\bBUSL\b/i,
  /\bBSL\b/i,
  /\bElastic\b/i,
  /\bPolyForm\b/i,
  /\bUNLICENSED\b/i,
  /\bUNKNOWN\b/i,
];

const run = (args) =>
  execFileSync("pnpm", args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: useShell,
    stdio: ["ignore", "pipe", "pipe"],
  });

const readProductionLicenses = () => {
  const output = run(["licenses", "list", "--prod", "--json"]);
  return JSON.parse(output);
};

const flattenLicenseReport = (report) => {
  const rows = [];
  for (const [license, packages] of Object.entries(report)) {
    for (const entry of packages) {
      for (const version of entry.versions ?? ["unknown"]) {
        rows.push({
          name: entry.name,
          version,
          license,
          source: entry.homepage || entry.repository || "",
        });
      }
    }
  }
  return rows.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
};

const missingFiles = requiredFiles.filter((file) => !existsSync(path.join(repoRoot, file)));
if (missingFiles.length > 0) {
  console.error(`License audit failed: missing ${missingFiles.join(", ")}`);
  process.exit(1);
}

const rows = flattenLicenseReport(readProductionLicenses());
const denied = rows.filter((row) =>
  deniedLicensePatterns.some((pattern) => pattern.test(row.license)),
);

if (denied.length > 0) {
  console.error("License audit failed: denied production licenses found.");
  for (const row of denied) {
    console.error(`- ${row.name}@${row.version}: ${row.license}`);
  }
  console.error(
    "Remove the dependency, replace it with a permissive alternative, or get legal approval before release.",
  );
  process.exit(1);
}

console.log(`ok - production dependency license audit passed (${rows.length} packages)`);
