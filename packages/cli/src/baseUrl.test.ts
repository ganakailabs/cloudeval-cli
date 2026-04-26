import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUD_BASE_URL,
  getDefaultBaseUrl,
  isLocalBaseUrl,
  shouldUseStoredBaseUrl,
} from "./baseUrl.js";

test("getDefaultBaseUrl uses production cloud when no explicit env override exists", () => {
  assert.equal(getDefaultBaseUrl({}), CLOUD_BASE_URL);
});

test("getDefaultBaseUrl uses explicit CLOUDEVAL_BASE_URL", () => {
  assert.equal(
    getDefaultBaseUrl({ CLOUDEVAL_BASE_URL: "http://127.0.0.1:8000/api/v1" }),
    "http://127.0.0.1:8000/api/v1"
  );
});

test("getDefaultBaseUrl ignores blank CLOUDEVAL_BASE_URL", () => {
  assert.equal(getDefaultBaseUrl({ CLOUDEVAL_BASE_URL: " " }), CLOUD_BASE_URL);
});

test("isLocalBaseUrl detects localhost development endpoints", () => {
  assert.equal(isLocalBaseUrl("http://127.0.0.1:8000/api/v1"), true);
  assert.equal(isLocalBaseUrl("http://localhost:8000/api/v1"), true);
  assert.equal(isLocalBaseUrl("http://[::1]:8000/api/v1"), true);
  assert.equal(isLocalBaseUrl("https://cloudeval.ai/api/v1"), false);
});

test("shouldUseStoredBaseUrl ignores stale local auth base URLs by default", () => {
  assert.equal(
    shouldUseStoredBaseUrl("http://127.0.0.1:8000/api/v1", {}),
    false
  );
});

test("shouldUseStoredBaseUrl allows local stored base URLs only with explicit opt-in", () => {
  assert.equal(
    shouldUseStoredBaseUrl("http://127.0.0.1:8000/api/v1", {
      CLOUDEVAL_ALLOW_STORED_LOCAL_BASE_URL: "1",
    }),
    true
  );
});

test("shouldUseStoredBaseUrl ignores stale non-default auth base URLs by default", () => {
  assert.equal(shouldUseStoredBaseUrl("https://staging.cloudeval.ai/api/v1", {}), false);
});

test("shouldUseStoredBaseUrl allows any stored base URL with explicit opt-in", () => {
  assert.equal(
    shouldUseStoredBaseUrl("https://staging.cloudeval.ai/api/v1", {
      CLOUDEVAL_USE_STORED_BASE_URL: "1",
    }),
    true
  );
});
