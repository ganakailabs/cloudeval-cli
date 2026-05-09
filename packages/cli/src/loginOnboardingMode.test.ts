import assert from "node:assert/strict";
import test from "node:test";
import { resolveLoginOnboardingMode } from "./loginOnboardingMode.js";

test("interactive login uses CLI onboarding steps when terminal is interactive", () => {
  assert.equal(
    resolveLoginOnboardingMode({
      headlessRequested: false,
      headlessEnvironment: false,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    }),
    "interactive_steps"
  );
});

test("headless login uses quick setup so automation does not wait for prompts", () => {
  assert.equal(
    resolveLoginOnboardingMode({
      headlessRequested: true,
      headlessEnvironment: false,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    }),
    "quick_setup"
  );
  assert.equal(
    resolveLoginOnboardingMode({
      headlessRequested: false,
      headlessEnvironment: true,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    }),
    "quick_setup"
  );
});

test("non-tty login uses quick setup because CLI onboarding cannot read prompts", () => {
  assert.equal(
    resolveLoginOnboardingMode({
      headlessRequested: false,
      headlessEnvironment: false,
      stdinIsTTY: false,
      stdoutIsTTY: true,
    }),
    "quick_setup"
  );
  assert.equal(
    resolveLoginOnboardingMode({
      headlessRequested: false,
      headlessEnvironment: false,
      stdinIsTTY: true,
      stdoutIsTTY: false,
    }),
    "quick_setup"
  );
});
