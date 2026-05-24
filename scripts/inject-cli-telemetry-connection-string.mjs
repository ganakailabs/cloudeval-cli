#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outputPath = path.join(
  repoRoot,
  "packages",
  "cli",
  "src",
  "telemetryConnectionString.generated.ts",
);

const connectionString =
  process.env.CLOUDEVAL_APPLICATIONINSIGHTS_CONNECTION_STRING?.trim() ||
  process.env.APPLICATIONINSIGHTS_CONNECTION_STRING?.trim() ||
  process.env.NEXT_PUBLIC_APPLICATIONINSIGHTS_CONNECTION_STRING?.trim() ||
  "";

writeFileSync(
  outputPath,
  [
    "// Generated during release builds when a packaged Application Insights connection string is available.",
    "// Local source keeps this empty so development and forks do not send telemetry unless explicitly configured.",
    `export const PACKAGED_APPLICATIONINSIGHTS_CONNECTION_STRING = ${JSON.stringify(connectionString)};`,
    "",
  ].join("\n"),
  "utf8",
);

console.log(
  connectionString
    ? "ok - injected CLI Application Insights connection string"
    : "ok - CLI Application Insights connection string not configured",
);
