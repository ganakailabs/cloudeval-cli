import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewAnnotations,
  extractReviewFindings,
  parseReviewGithubConfig,
} from "./reviewFindings.js";

const reviewData = {
  sourceRoot: "infra",
  changedFiles: [
    { path: "infra/nested/compute.json", status: "modified" },
    { path: "infra/nested/network.json", status: "modified" },
  ],
  gate: {
    validation: {
      unitTests: {
        failures: [
          {
            test_name: "Secure admin credentials",
            file_path: "nested/compute.json",
            line_number: 27,
            severity: "error",
            message: "adminPassword is a plain string.",
            recommendation: "Use a secure parameter.",
          },
        ],
      },
      policyChecks: {
        failures: [
          {
            rule_name: "Subnet NSG required",
            file_path: "nested/network.json",
            line: 12,
            severity: "warning",
            message: "Subnet has no NSG.",
          },
        ],
      },
    },
    wellArchitected: {
      topFindings: [
        {
          id: "CEV-001",
          title: "Storage account permits public access",
          severity: "high",
          path: "infra/storage.json",
          line: 44,
          message: "Public blob access is enabled.",
        },
      ],
    },
  },
};

test("extractReviewFindings normalizes source-root paths and public failure metadata", () => {
  const findings = extractReviewFindings(reviewData);

  assert.deepEqual(
    findings.map((finding) => ({
      kind: finding.kind,
      title: finding.title,
      path: finding.path,
      line: finding.startLine,
      level: finding.level,
    })),
    [
      {
        kind: "unit_test",
        title: "Secure admin credentials",
        path: "infra/nested/compute.json",
        line: 27,
        level: "failure",
      },
      {
        kind: "policy_check",
        title: "Subnet NSG required",
        path: "infra/nested/network.json",
        line: 12,
        level: "warning",
      },
      {
        kind: "well_architected",
        title: "Storage account permits public access",
        path: "infra/storage.json",
        line: 44,
        level: "failure",
      },
    ],
  );
  assert.match(findings[0].message, /Use a secure parameter/);
});

test("buildReviewAnnotations can restrict annotations to changed files", () => {
  const annotations = buildReviewAnnotations(reviewData, {
    changedFilesOnly: true,
    includeNotices: false,
    annotationLimit: 10,
  });

  assert.deepEqual(
    annotations.map((annotation) => ({
      path: annotation.path,
      start_line: annotation.start_line,
      annotation_level: annotation.annotation_level,
      title: annotation.title,
    })),
    [
      {
        path: "infra/nested/compute.json",
        start_line: 27,
        annotation_level: "failure",
        title: "Secure admin credentials",
      },
      {
        path: "infra/nested/network.json",
        start_line: 12,
        annotation_level: "warning",
        title: "Subnet NSG required",
      },
    ],
  );
});

test("parseReviewGithubConfig reads Checks and SARIF settings", () => {
  const config = parseReviewGithubConfig(`
ci:
  review:
    github:
      checks:
        enabled: true
        annotation_limit: 75
        changed_files_only: false
        include_notices: true
      sarif:
        enabled: true
        category: cloudeval-azure
        upload: true
        fail_on_upload_error: true
`);

  assert.equal(config.checks.enabled, true);
  assert.equal(config.checks.annotationLimit, 75);
  assert.equal(config.checks.changedFilesOnly, false);
  assert.equal(config.checks.includeNotices, true);
  assert.equal(config.sarif.enabled, true);
  assert.equal(config.sarif.category, "cloudeval-azure");
  assert.equal(config.sarif.upload, true);
  assert.equal(config.sarif.failOnUploadError, true);
});
