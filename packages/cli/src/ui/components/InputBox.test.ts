import assert from "node:assert/strict";
import test from "node:test";
import { shouldSubmitInputOnReturn } from "../inputSubmitBehavior";

test("shouldSubmitInputOnReturn lets empty Enter open focused controls", () => {
  assert.equal(shouldSubmitInputOnReturn(""), false);
  assert.equal(shouldSubmitInputOnReturn("   \n  "), false);
  assert.equal(shouldSubmitInputOnReturn("select model"), true);
  assert.equal(shouldSubmitInputOnReturn("/model"), true);
});
