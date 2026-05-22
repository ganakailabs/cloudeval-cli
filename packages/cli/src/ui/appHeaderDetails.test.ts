import assert from "node:assert/strict";
import test from "node:test";
import "../runtime/prepareInk";
import { buildTuiHeaderDetails } from "./App";

test("buildTuiHeaderDetails includes the logged-in user name in banner details", () => {
  assert.deepEqual(
    buildTuiHeaderDetails({
      apiBase: "https://cloudeval.ai/api/proxy/v1",
      frontendBaseUrl: "https://cloudeval.ai",
      billingSummary: "Plan: Free | Credits: 120 left",
      userName: "Manu",
    }),
    [
      "User: Manu",
      "API: https://cloudeval.ai/api/proxy/v1",
      "Frontend: https://cloudeval.ai",
      "Plan: Free | Credits: 120 left",
    ]
  );
});
