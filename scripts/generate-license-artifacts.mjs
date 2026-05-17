#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const checkOnly = process.argv.includes("--check");
const cliPackage = JSON.parse(readFileSync(path.join(repoRoot, "packages/cli/package.json"), "utf8"));
const generatedAt =
  process.env.CLOUDEVAL_LICENSE_GENERATED_AT ||
  (process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : "2026-05-17T00:00:00.000Z");

const run = (args) =>
  execFileSync("pnpm", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const report = JSON.parse(run(["licenses", "list", "--prod", "--json"]));

const sourceFor = (entry) => {
  if (typeof entry.homepage === "string" && entry.homepage.length > 0) {
    return entry.homepage;
  }
  if (typeof entry.repository === "string" && entry.repository.length > 0) {
    return entry.repository;
  }
  if (entry.repository && typeof entry.repository.url === "string") {
    return entry.repository.url;
  }
  return "NOASSERTION";
};

const rows = [];
for (const [license, packages] of Object.entries(report)) {
  for (const entry of packages) {
    for (const version of entry.versions ?? ["unknown"]) {
      rows.push({
        name: entry.name,
        version,
        license,
        author: entry.author || "NOASSERTION",
        source: sourceFor(entry),
        description: entry.description || "",
      });
    }
  }
}

rows.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));

const licenseCounts = rows.reduce((acc, row) => {
  acc.set(row.license, (acc.get(row.license) ?? 0) + 1);
  return acc;
}, new Map());

const escapeCell = (value) => String(value).replaceAll("|", "\\|").replace(/\s+/g, " ").trim();

const noticeLines = [
  "# Third Party Notices",
  "",
  "This file lists production third-party packages included in CloudEval CLI release artifacts.",
  "It is generated from the pnpm production dependency graph.",
  "",
  `Generated: ${generatedAt}`,
  "",
  "CloudEval-authored code is licensed under LICENSE. Third-party packages remain governed by their own licenses.",
  "This notice is not a substitute for legal review before public or enterprise distribution.",
  "",
  "## License Summary",
  "",
  "| License | Package count |",
  "| --- | ---: |",
  ...[...licenseCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([license, count]) => `| ${escapeCell(license)} | ${count} |`),
  "",
  "## Production Packages",
  "",
  "| Package | Version | License | Author | Source |",
  "| --- | --- | --- | --- | --- |",
  ...rows.map(
    (row) =>
      `| ${escapeCell(row.name)} | ${escapeCell(row.version)} | ${escapeCell(row.license)} | ${escapeCell(row.author)} | ${escapeCell(row.source)} |`,
  ),
  "",
];

const thirdPartyNotices = noticeLines.join("\n");

const spdxPackages = rows.map((row) => ({
  SPDXID: `SPDXRef-Package-${row.name.replace(/[^A-Za-z0-9.-]/g, "-")}-${row.version.replace(/[^A-Za-z0-9.-]/g, "-")}`,
  name: row.name,
  versionInfo: row.version,
  downloadLocation: row.source,
  filesAnalyzed: false,
  licenseConcluded: row.license,
  licenseDeclared: row.license,
  copyrightText: row.author === "NOASSERTION" ? "NOASSERTION" : row.author,
  summary: row.description,
}));

const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "CloudEval CLI production dependency SBOM",
  documentNamespace: `https://github.com/ganakailabs/cloudeval-cli/sbom/${generatedAt}`,
  creationInfo: {
    created: generatedAt,
    creators: ["Tool: scripts/generate-license-artifacts.mjs"],
  },
  packages: [
    {
      SPDXID: "SPDXRef-Package-CloudEval-CLI",
      name: "CloudEval CLI",
      versionInfo: cliPackage.version,
      downloadLocation: "https://github.com/ganakailabs/cloudeval-cli",
      filesAnalyzed: false,
      licenseConcluded: "LicenseRef-CloudEval-CLI",
      licenseDeclared: "LicenseRef-CloudEval-CLI",
      copyrightText: "Copyright (c) 2026 Ganak AI Labs. All rights reserved.",
    },
    ...spdxPackages,
  ],
  relationships: spdxPackages.map((pkg) => ({
    spdxElementId: "SPDXRef-Package-CloudEval-CLI",
    relationshipType: "DEPENDS_ON",
    relatedSpdxElement: pkg.SPDXID,
  })),
};

const sbomJson = `${JSON.stringify(sbom, null, 2)}\n`;

const outputs = [
  ["THIRD_PARTY_NOTICES.md", thirdPartyNotices],
  ["sbom.spdx.json", sbomJson],
];

if (checkOnly) {
  const stale = outputs.filter(([file, content]) => {
    const target = path.join(repoRoot, file);
    return !existsSync(target) || readFileSync(target, "utf8") !== content;
  });
  if (stale.length > 0) {
    console.error(`License artifacts are stale: ${stale.map(([file]) => file).join(", ")}`);
    console.error("Run pnpm license:artifacts and commit the result.");
    process.exit(1);
  }
  console.log(`ok - license artifacts are current (${rows.length} packages)`);
} else {
  for (const [file, content] of outputs) {
    writeFileSync(path.join(repoRoot, file), content, "utf8");
  }
  console.log(`ok - wrote THIRD_PARTY_NOTICES.md and sbom.spdx.json for ${rows.length} packages`);
}
