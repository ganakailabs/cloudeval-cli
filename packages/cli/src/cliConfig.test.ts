import assert from "node:assert/strict";
import test from "node:test";
import {
  readCliConfigValue,
  unsetCliConfigValue,
  writeCliConfigValue,
} from "./cliConfig";

test("config helpers read and write telemetry.enabled", () => {
  const disabled = writeCliConfigValue({}, "telemetry.enabled", "false");
  assert.deepEqual(disabled, { telemetry: { enabled: false } });
  assert.equal(readCliConfigValue(disabled, "telemetry.enabled"), "false");

  const enabled = writeCliConfigValue(disabled, "telemetry.enabled", "true");
  assert.deepEqual(enabled, { telemetry: { enabled: true } });
  assert.equal(readCliConfigValue(enabled, "telemetry.enabled"), "true");
});

test("config helpers unset telemetry.enabled and reject invalid booleans", () => {
  const config = writeCliConfigValue({}, "telemetry.enabled", "false");
  assert.deepEqual(unsetCliConfigValue(config, "telemetry.enabled"), {});
  assert.throws(
    () => writeCliConfigValue({}, "telemetry.enabled", "maybe"),
    /telemetry.enabled must be true or false/,
  );
});
