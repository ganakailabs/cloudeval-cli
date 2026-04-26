import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateBannerRows,
  getPromptInputRowBudget,
  getResponsiveTuiLayout,
  truncateForTerminal,
} from "./layout";

test("getResponsiveTuiLayout keeps the banner visible in cramped terminals with extra panels", () => {
  const layout = getResponsiveTuiLayout(
    { columns: 80, rows: 24 },
    { hasQueue: true, hasError: true }
  );

  assert.equal(layout.compact, true);
  assert.equal(layout.showBanner, true);
  assert.ok(layout.threadHeight >= 4);
  assert.ok(layout.threadHeight <= 16);
});

test("getResponsiveTuiLayout keeps the banner visible in normal compact chat windows", () => {
  const layout = getResponsiveTuiLayout({ columns: 100, rows: 28 });

  assert.equal(layout.compact, true);
  assert.equal(layout.showBanner, true);
  assert.ok(layout.threadHeight >= 6);
});

test("getResponsiveTuiLayout keeps more transcript space on large terminals", () => {
  const layout = getResponsiveTuiLayout({ columns: 140, rows: 48 });

  assert.equal(layout.compact, false);
  assert.equal(layout.showBanner, true);
  assert.ok(layout.threadHeight >= 10);
});

test("truncateForTerminal uses ascii ellipsis and preserves short text", () => {
  assert.equal(truncateForTerminal("short", 20), "short");
  assert.equal(truncateForTerminal("abcdefghijklmnopqrstuvwxyz", 10), "abcdefg...");
});

test("getPromptInputRowBudget uses available terminal height for the prompt", () => {
  assert.equal(getPromptInputRowBudget({ columns: 120, rows: 24 }), 4);
  assert.equal(getPromptInputRowBudget({ columns: 120, rows: 48 }), 10);
  assert.equal(getPromptInputRowBudget({ columns: 160, rows: 80 }), 16);
});

test("estimateBannerRows counts the Welcome row in each banner layout", () => {
  assert.equal(estimateBannerRows({ columns: 140, detailsCount: 3 }), 8);
  assert.equal(estimateBannerRows({ columns: 100, detailsCount: 3 }), 12);
  assert.equal(estimateBannerRows({ columns: 80, detailsCount: 3 }), 5);
});
