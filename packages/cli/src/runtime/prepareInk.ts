import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const YOGA_WASM_ENV_VAR = "CLOUDEVAL_YOGA_WASM";

const hasFile = (candidate: string): boolean => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

const findInNodeModules = (dir: string): string | undefined => {
  const nodeModulesDir = path.join(dir, "node_modules");
  const direct = path.join(nodeModulesDir, "yoga-wasm-web", "dist", "yoga.wasm");
  if (hasFile(direct)) {
    return direct;
  }

  const pnpmRoot = path.join(nodeModulesDir, ".pnpm");
  if (!fs.existsSync(pnpmRoot)) {
    return undefined;
  }

  for (const entry of fs.readdirSync(pnpmRoot)) {
    if (!entry.startsWith("yoga-wasm-web@")) {
      continue;
    }

    const candidate = path.join(
      pnpmRoot,
      entry,
      "node_modules",
      "yoga-wasm-web",
      "dist",
      "yoga.wasm"
    );

    if (hasFile(candidate)) {
      return candidate;
    }
  }

  return undefined;
};

const searchFrom = (start: string): string | undefined => {
  let current = path.resolve(start);

  while (true) {
    const localCandidates = [
      path.join(current, "yoga.wasm"),
      path.join(current, "dist", "yoga.wasm"),
    ];

    for (const candidate of localCandidates) {
      if (hasFile(candidate)) {
        return candidate;
      }
    }

    const nodeModulesMatch = findInNodeModules(current);
    if (nodeModulesMatch) {
      return nodeModulesMatch;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
};

export const resolveYogaWasmPath = (): string | undefined => {
  if (process.env[YOGA_WASM_ENV_VAR]) {
    return process.env[YOGA_WASM_ENV_VAR];
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const seen = new Set<string>();
  const roots = [process.cwd(), moduleDir, path.dirname(process.execPath)];

  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    if (seen.has(resolvedRoot)) {
      continue;
    }
    seen.add(resolvedRoot);

    const match = searchFrom(resolvedRoot);
    if (match) {
      return match;
    }
  }

  return undefined;
};

export const ensureInkRuntimeEnvironment = (): void => {
  if (process.env[YOGA_WASM_ENV_VAR]) {
    return;
  }

  const resolvedPath = resolveYogaWasmPath();
  if (resolvedPath) {
    process.env[YOGA_WASM_ENV_VAR] = resolvedPath;
  }
};

ensureInkRuntimeEnvironment();
