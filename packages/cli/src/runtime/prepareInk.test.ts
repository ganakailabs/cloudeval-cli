import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureInkRuntimeEnvironment,
  resolveYogaWasmPath,
  YOGA_WASM_ENV_VAR,
} from "./prepareInk";

test("resolveYogaWasmPath finds the bundled yoga wasm asset", () => {
  const resolvedPath = resolveYogaWasmPath();
  assert.ok(resolvedPath, "expected a yoga.wasm path");
  assert.match(resolvedPath, /yoga\.wasm$/);
});

test("ensureInkRuntimeEnvironment populates the expected env var", () => {
  const previousValue = process.env[YOGA_WASM_ENV_VAR];
  delete process.env[YOGA_WASM_ENV_VAR];

  try {
    ensureInkRuntimeEnvironment();
    assert.ok(process.env[YOGA_WASM_ENV_VAR]);
    assert.match(process.env[YOGA_WASM_ENV_VAR] as string, /yoga\.wasm$/);
  } finally {
    if (previousValue === undefined) {
      delete process.env[YOGA_WASM_ENV_VAR];
    } else {
      process.env[YOGA_WASM_ENV_VAR] = previousValue;
    }
  }
});
