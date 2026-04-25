import assert from "node:assert/strict";
import test from "node:test";
import { getFirstNameForDisplay } from "./userDisplayName";

test("getFirstNameForDisplay prefers the first token from full name", () => {
  assert.equal(
    getFirstNameForDisplay({
      email: "prateeksingh1590@gmail.com",
      full_name: "Prateek Singh",
    }),
    "Prateek"
  );
});

test("getFirstNameForDisplay falls back to a cleaned email local part", () => {
  assert.equal(
    getFirstNameForDisplay({ email: "eva.user-123@example.com" }),
    "Eva"
  );
});
