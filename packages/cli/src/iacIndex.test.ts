import assert from "node:assert/strict";
import test from "node:test";
import {
  detectIacTargets,
  indexIacDocument,
  normalizeSeverity,
  summarizeFindings,
} from "./iacIndex";

test("detectIacTargets detects supported and indexed-only IaC files", () => {
  const result = detectIacTargets([
    "main.bicep",
    "azuredeploy.json",
    "modules/network.tf",
    "stacks/app.tofu",
    ".vscode/settings.json",
    "README.md",
  ]);

  assert.deepEqual(
    result.targets.map((target) => ({
      adapter: target.adapter,
      path: target.path,
      supportLevel: target.supportLevel,
    })),
    [
      { adapter: "bicep", path: "main.bicep", supportLevel: "full" },
      { adapter: "arm", path: "azuredeploy.json", supportLevel: "full" },
      { adapter: "terraform", path: "modules/network.tf", supportLevel: "indexed_only" },
      { adapter: "opentofu", path: "stacks/app.tofu", supportLevel: "indexed_only" },
    ]
  );
  assert.equal(result.summary.full, 2);
  assert.equal(result.summary.indexedOnly, 2);
});

test("indexIacDocument maps ARM resources to stable ranges", () => {
  const content = JSON.stringify(
    {
      $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
      resources: [
        {
          type: "Microsoft.Storage/storageAccounts",
          name: "storage1",
          apiVersion: "2023-01-01",
        },
      ],
    },
    null,
    2
  );

  const index = indexIacDocument({
    path: "azuredeploy.json",
    content,
  });

  assert.equal(index.adapter, "arm");
  assert.equal(index.supportLevel, "full");
  assert.equal(index.resources.length, 1);
  assert.deepEqual(index.resources[0], {
    adapter: "arm",
    filePath: "azuredeploy.json",
    range: { startLine: 3, startCharacter: 4, endLine: 7, endCharacter: 5 },
    address: "Microsoft.Storage/storageAccounts.storage1",
    resourceType: "Microsoft.Storage/storageAccounts",
    resourceName: "storage1",
    supportLevel: "full",
  });
});

test("indexIacDocument maps Terraform and OpenTofu resources as indexed-only", () => {
  const terraform = indexIacDocument({
    path: "main.tf",
    content: [
      'resource "azurerm_storage_account" "main" {',
      '  name = "storage1"',
      "}",
      "",
    ].join("\n"),
  });
  const tofu = indexIacDocument({
    path: "main.tofu",
    content: [
      'resource "azurerm_resource_group" "rg" {',
      '  name = "rg1"',
      "}",
      "",
    ].join("\n"),
  });

  assert.equal(terraform.supportLevel, "indexed_only");
  assert.equal(terraform.resources[0].address, "azurerm_storage_account.main");
  assert.equal(terraform.resources[0].range.startLine, 0);
  assert.equal(terraform.resources[0].range.endLine, 2);
  assert.equal(tofu.adapter, "opentofu");
  assert.equal(tofu.resources[0].supportLevel, "indexed_only");
});

test("summarizeFindings returns status-bar ready counts", () => {
  assert.deepEqual(
    summarizeFindings([
      { severity: "critical" },
      { severity: "high" },
      { severity: "medium" },
      { severity: "medium" },
      { severity: "warning" },
    ]),
    {
      total: 5,
      critical: 1,
      high: 1,
      medium: 3,
      low: 0,
      info: 0,
      statusText: "1 critical • 1 high • 3 medium",
    }
  );
  assert.equal(normalizeSeverity("Error"), "high");
  assert.equal(normalizeSeverity("Warning"), "medium");
  assert.equal(summarizeFindings([{ severity: "info" }]).statusText, "1 info");
});
