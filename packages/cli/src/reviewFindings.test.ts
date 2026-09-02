import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLocatedReviewFindings,
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
  assert.match(findings[0].message, /plain string/);
  assert.equal(findings[0].recommendation, "Use a secure parameter.");
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

test("buildReviewAnnotations skips generic gate fallback when reports lack source-mapped findings", () => {
  const annotations = buildReviewAnnotations(
    {
      changedFiles: [
        {
          path: "README.md",
          status: "modified",
          patch: "@@ -1 +1 @@\n-old\n+new",
        },
        {
          path: "azuredeploy.json",
          status: "modified",
          patch: "@@ -29,0 +30,4 @@\n+    \"sqlAdministratorPassword\": {\n+      \"type\": \"secureString\"\n+    },",
        },
        {
          path: "nested/database.json",
          status: "added",
          patch: "@@ -0,0 +1,3 @@\n+{\n+  \"resources\": []\n+}",
        },
      ],
      gate: {
        status: "fail",
        failures: [
          "overall score 48 is below 60",
          "validation has 0 failed policy checks and 2 failed unit tests",
        ],
        validation: {
          unitTests: {
            failed: 2,
            failures: [],
          },
          policyChecks: {
            failed: 0,
            failures: [],
          },
        },
        wellArchitected: {
          topFindings: [],
        },
      },
    },
    {
      changedFilesOnly: true,
      includeNotices: false,
      annotationLimit: 10,
    },
  );

  assert.deepEqual(annotations, []);
});

test("buildLocatedReviewFindings leaves passing reviews without fallback findings", () => {
  assert.deepEqual(
    buildLocatedReviewFindings({
      changedFiles: [{ path: "azuredeploy.json", status: "modified" }],
      gate: { status: "pass", failures: [] },
    }),
    [],
  );
});

test("buildReviewAnnotations adds deterministic IaC findings from changed ARM lines", () => {
  const annotations = buildReviewAnnotations(
    {
      changedFiles: [
        {
          path: "nested/database.json",
          status: "modified",
          patch: [
            "@@ -20,6 +20,8 @@",
            '         "administratorLogin": "sqladmin",',
            '+        "minimalTlsVersion": "1.0",',
            '+        "publicNetworkAccess": "Enabled",',
            '         "version": "12.0"',
          ].join("\n"),
        },
      ],
      gate: { validation: {}, wellArchitected: {} },
    },
    {
      changedFilesOnly: true,
      includeNotices: false,
      annotationLimit: 10,
    },
  );

  assert.deepEqual(
    annotations.map((annotation) => ({
      path: annotation.path,
      start_line: annotation.start_line,
      level: annotation.annotation_level,
      title: annotation.title,
      raw_details: annotation.raw_details,
      finding_kind: annotation.finding_kind,
      severity: annotation.severity,
      pillar: annotation.pillar,
      rule_id: annotation.rule_id,
      recommendation: annotation.recommendation,
      changed_setting: annotation.changed_setting,
    })),
    [
      {
        path: "nested/database.json",
        start_line: 21,
        level: "failure",
        title: "TLS version is below 1.2",
        raw_details: "Cloudeval IaC review · high · tls-version-below-12",
        finding_kind: "local_iac_check",
        severity: "high",
        pillar: "Security",
        rule_id: "tls-version-below-12",
        recommendation: "Use TLS 1.2 or higher before merging.",
        changed_setting: "minimumTlsVersion",
      },
      {
        path: "nested/database.json",
        start_line: 22,
        level: "warning",
        title: "Public network access is enabled",
        raw_details: "Cloudeval IaC review · medium · public-network-access-enabled",
        finding_kind: "local_iac_check",
        severity: "medium",
        pillar: "Security",
        rule_id: "public-network-access-enabled",
        recommendation:
          "Prefer private endpoints or explicit network rules for production-facing resources.",
        changed_setting: "publicNetworkAccess",
      },
    ],
  );
  assert.match(annotations[0].message, /minimumTlsVersion/);
  assert.doesNotMatch(String(annotations[0].raw_details), /local_iac_check/);
});

test("buildLocatedReviewFindings does not fabricate source locations from source_root", () => {
  const annotations = buildReviewAnnotations(
    {
      sourceRoot: "infra",
      changedFiles: [
        {
          path: "nested/database.json",
          status: "modified",
          patch: "@@ -3,0 +4,2 @@\n+  \"publicNetworkAccess\": \"Enabled\",",
        },
      ],
      gate: {
        status: "fail",
        failures: ["Cost Optimization score 0 is below 50"],
      },
    },
    {
      changedFilesOnly: true,
      includeNotices: false,
      annotationLimit: 10,
    },
  );

  assert.deepEqual(annotations, []);
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
