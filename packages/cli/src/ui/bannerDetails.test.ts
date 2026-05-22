import assert from "node:assert/strict";
import test from "node:test";
import { buildBannerDetailLines, buildTuiHeaderDetails } from "./bannerDetails.js";

test("buildTuiHeaderDetails includes email in parentheses when provided", () => {
  assert.deepEqual(
    buildTuiHeaderDetails({
      apiBase: "https://cloudeval.ai/api/proxy/v1",
      frontendBaseUrl: "https://cloudeval.ai",
      billingSummary: "Plan: Free | Credits: 120 left",
      userName: "Manu",
      userEmail: "manu@example.com",
    }),
    [
      "User: Manu (manu@example.com)",
      "API: https://cloudeval.ai/api/proxy/v1",
      "Frontend: https://cloudeval.ai",
      "Plan: Free | Credits: 120 left",
    ]
  );
});

test("buildBannerDetailLines colors the user name separately from email", () => {
  const lines = buildBannerDetailLines({
    apiBase: "https://cloudeval.ai/api/proxy/v1",
    frontendBaseUrl: "https://cloudeval.ai",
    billingSummary: "Plan: Free | Credits: 120 left",
    userName: "Manu",
    userEmail: "manu@example.com",
  });

  assert.equal(lines[0]?.segments[0]?.text, "User: ");
  assert.equal(lines[0]?.segments[1]?.text, "Manu");
  assert.match(lines[0]?.segments[2]?.text ?? "", /\(manu@example\.com\)/);
});
