import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildIacDetectData,
  buildIacIndexData,
  IDE_SCHEMA_VERSION,
} from "./iacCommand";

test("buildIacDetectData returns IDE schema metadata and detection summary", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-iac-detect-"));
  await fs.writeFile(path.join(workspace, "main.bicep"), "resource sa 'Microsoft.Storage/storageAccounts@2023-01-01' = {}\n");
  await fs.mkdir(path.join(workspace, "modules"));
  await fs.writeFile(path.join(workspace, "modules", "network.tf"), 'resource "azurerm_virtual_network" "main" {}\n');

  const data = await buildIacDetectData({ workspace });

  assert.equal(data.schemaVersion, IDE_SCHEMA_VERSION);
  assert.equal(data.workspace, workspace);
  assert.deepEqual(
    data.detection.targets.map((target) => ({
      adapter: target.adapter,
      path: target.path,
      supportLevel: target.supportLevel,
    })),
    [
      { adapter: "bicep", path: "main.bicep", supportLevel: "full" },
      { adapter: "terraform", path: "modules/network.tf", supportLevel: "indexed_only" },
    ]
  );
});

test("buildIacIndexData returns per-file resource index", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-iac-index-"));
  const file = path.join(workspace, "main.tf");
  await fs.writeFile(file, 'resource "azurerm_storage_account" "main" {}\n');

  const data = await buildIacIndexData({ file });

  assert.equal(data.schemaVersion, IDE_SCHEMA_VERSION);
  assert.equal(data.indexes.length, 1);
  assert.equal(data.indexes[0].adapter, "terraform");
  assert.equal(data.indexes[0].supportLevel, "indexed_only");
  assert.equal(data.indexes[0].resources[0].address, "azurerm_storage_account.main");
});
