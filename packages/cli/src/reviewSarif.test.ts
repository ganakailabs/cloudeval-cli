import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewSarifLog } from "./reviewSarif.js";

test("buildReviewSarifLog renders CloudEval findings as SARIF 2.1.0", () => {
  const sarif = buildReviewSarifLog({
    category: "cloudeval-iac",
    findings: [
      {
        id: "unit-test:secure-admin-credentials",
        kind: "unit_test",
        title: "Secure admin credentials",
        message: "adminPassword is a plain string. Use a secure parameter.",
        path: "infra/nested/compute.json",
        startLine: 27,
        level: "failure",
        severity: "error",
      },
      {
        id: "policy:subnet-nsg-required",
        kind: "policy_check",
        title: "Subnet NSG required",
        message: "Subnet has no NSG.",
        path: "infra/nested/network.json",
        startLine: 12,
        level: "warning",
        severity: "warning",
      },
    ],
  });

  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs[0].tool.driver.name, "CloudEval");
  assert.equal(sarif.runs[0].automationDetails.id, "cloudeval-iac");
  assert.deepEqual(
    sarif.runs[0].tool.driver.rules.map((rule) => rule.id),
    ["unit-test:secure-admin-credentials", "policy:subnet-nsg-required"],
  );
  assert.equal(sarif.runs[0].results[0].level, "error");
  assert.equal(
    sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
    "infra/nested/compute.json",
  );
  assert.equal(
    sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine,
    27,
  );
});
