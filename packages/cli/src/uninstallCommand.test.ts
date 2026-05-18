import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatUninstallResultText,
  handleUninstallCommand,
} from "./uninstallCommand.js";

const writeFile = async (filePath: string, value = "x") => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
};

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

test("uninstall removes installer artifacts and keeps config by default", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-uninstall-home-"));
  const binDir = path.join(home, ".local", "bin");
  const binary = path.join(binDir, "cloudeval");
  const config = path.join(home, ".config", "cloudeval", "settings.json");
  const bashCompletion = path.join(
    home,
    ".local",
    "share",
    "bash-completion",
    "completions",
    "cloudeval",
  );
  const licenseFile = path.join(
    home,
    ".local",
    "share",
    "cloudeval",
    "licenses",
    "LICENSE",
  );
  const bashrc = path.join(home, ".bashrc");

  try {
    await writeFile(binary, "#!/bin/sh\n");
    await fs.symlink(binary, path.join(binDir, "eva"));
    await fs.symlink(binary, path.join(binDir, "cloud"));
    await writeFile(path.join(binDir, "yoga.wasm"), "wasm");
    await writeFile(config, "{}\n");
    await writeFile(bashCompletion, "complete -F _cloudeval_completion cloudeval\n");
    await writeFile(licenseFile, "license\n");
    await writeFile(
      bashrc,
      `before\n\n# Cloudeval CLI\nexport PATH="${binDir}:$PATH"\nafter\n`,
    );

    const result = await handleUninstallCommand({ yes: true }, { home });

    assert.equal(await pathExists(binary), false);
    assert.equal(await pathExists(path.join(binDir, "eva")), false);
    assert.equal(await pathExists(path.join(binDir, "cloud")), false);
    assert.equal(await pathExists(path.join(binDir, "yoga.wasm")), false);
    assert.equal(await pathExists(bashCompletion), false);
    assert.equal(await pathExists(path.dirname(licenseFile)), false);
    assert.equal(await pathExists(config), true);
    assert.equal(await fs.readFile(bashrc, "utf8"), "before\nafter\n");
    assert.equal(result.removeConfig, false);
    assert.ok(result.actions.some((action) => action.label === "config" && action.status === "kept"));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("uninstall can remove config when explicitly requested", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-uninstall-config-home-"));
  const configDir = path.join(home, ".config", "cloudeval");
  try {
    await writeFile(path.join(configDir, "settings.json"), "{}\n");
    await writeFile(path.join(configDir, "sessions.sqlite"), "sqlite\n");

    const result = await handleUninstallCommand(
      { yes: true, removeConfig: true },
      { home },
    );

    assert.equal(await pathExists(configDir), false);
    assert.ok(result.actions.some((action) => action.label === "config" && action.status === "removed"));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("uninstall dry-run reports cleanup without removing files", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-uninstall-dry-run-home-"));
  const binary = path.join(home, ".local", "bin", "cloudeval");
  try {
    await writeFile(binary, "#!/bin/sh\n");

    const result = await handleUninstallCommand({ dryRun: true }, { home });
    const text = formatUninstallResultText(result);

    assert.equal(await pathExists(binary), true);
    assert.ok(result.actions.some((action) => action.path === binary && action.status === "would_remove"));
    assert.match(text, /Mode: dry run/);
    assert.match(text, /Config: kept/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("uninstall refuses non-interactive removal without confirmation", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-uninstall-confirm-home-"));
  try {
    await assert.rejects(
      handleUninstallCommand(
        {},
        { home, inputIsTTY: false },
      ),
      /Re-run with --yes/,
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
