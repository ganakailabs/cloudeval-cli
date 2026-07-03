#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

const allowedDeniedPackages = new Set([
  "@ganakailabs/cloudeval-signalstory-rules",
]);

const run = (args) =>
  execFileSync("pnpm", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    shell: useShell,
    stdio: ["ignore", "pipe", "pipe"],
  });

const readProductionLicenses = () => {
  try {
    const output = run(["licenses", "list", "--prod", "--json"]);
    return JSON.parse(output);
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    if (!stdout.includes("ERR_PNPM_UNSUPPORTED_PACKAGE_TYPE")) {
      throw error;
    }
    return null;
  }
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

const readRowsFromNotices = () => {
  const notices = readFileSync(path.join(repoRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  return notices
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| ---") && !line.startsWith("| License "))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 5 && cells[0] !== "Package")
    .map(([name, version, license, _author, source]) => ({
      name,
      version,
      license,
      source,
    }));
};

const missingFiles = requiredFiles.filter((file) => !existsSync(path.join(repoRoot, file)));
if (missingFiles.length > 0) {
  console.error(`License audit failed: missing ${missingFiles.join(", ")}`);
  process.exit(1);
}

const productionLicenses = readProductionLicenses();
const rows = productionLicenses ? flattenLicenseReport(productionLicenses) : readRowsFromNotices();
const denied = rows.filter((row) =>
  !allowedDeniedPackages.has(row.name) &&
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
