import assert from "node:assert/strict";
import test from "node:test";
import { getResponsiveTuiLayout, truncateForTerminal } from "./layout";

test("getResponsiveTuiLayout hides the banner in cramped terminals with extra panels", () => {
  const layout = getResponsiveTuiLayout(
    { columns: 80, rows: 24 },
    { hasQueue: true, hasError: true }
  );

  assert.equal(layout.compact, true);
  assert.equal(layout.showBanner, false);
  assert.ok(layout.threadHeight >= 4);
  assert.ok(layout.threadHeight <= 16);
});

test("getResponsiveTuiLayout keeps the banner in normal compact chat windows", () => {
  const layout = getResponsiveTuiLayout({ columns: 100, rows: 28 });

  assert.equal(layout.compact, true);
  assert.equal(layout.showBanner, true);
  assert.ok(layout.threadHeight >= 6);
});

test("getResponsiveTuiLayout keeps more transcript space on large terminals", () => {
  const layout = getResponsiveTuiLayout({ columns: 140, rows: 48 });

  assert.equal(layout.compact, false);
  assert.equal(layout.showBanner, true);
  assert.ok(layout.threadHeight > 16);
});

test("truncateForTerminal uses ascii ellipsis and preserves short text", () => {
  assert.equal(truncateForTerminal("short", 20), "short");
  assert.equal(truncateForTerminal("abcdefghijklmnopqrstuvwxyz", 10), "abcdefg...");
});
