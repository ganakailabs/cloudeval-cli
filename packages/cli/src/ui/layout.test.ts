import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateComposerRows,
  estimateBannerRows,
  getChatResponsiveMode,
  getContextRailWidth,
  getFramedBodyRows,
  getMiddleViewportRows,
  getPromptInputRowBudget,
  getResponsiveTuiLayout,
  shouldUseSplitChatLayout,
  truncateForTerminal,
} from "./layout";

test("getMiddleViewportRows leaves only remaining rows for scrollable middle content", () => {
  assert.equal(
    getMiddleViewportRows(
      { columns: 160, rows: 42 },
      { headerRows: 12, footerRows: 10, safetyRows: 0 }
    ),
    20
  );
  assert.equal(
    getMiddleViewportRows(
      { columns: 160, rows: 18 },
      { headerRows: 12, footerRows: 10, safetyRows: 0 }
    ),
    1
  );
});

test("getMiddleViewportRows reserves terminal frame safety rows by default", () => {
  assert.equal(
    getMiddleViewportRows({ columns: 160, rows: 42 }, { headerRows: 12, footerRows: 10 }),
    18
  );
});

test("getFramedBodyRows keeps scrollable content inside a visible panel frame", () => {
  assert.equal(getFramedBodyRows(20), 16);
  assert.equal(getFramedBodyRows(4), 1);
});

test("getResponsiveTuiLayout shrinks the transcript in cramped terminals with extra panels", () => {
  const layout = getResponsiveTuiLayout(
    { columns: 80, rows: 24 },
    { hasQueue: true, hasError: true }
  );

  assert.equal(layout.compact, true);
  assert.equal(layout.showBanner, true);
  assert.equal(layout.threadHeight, 1);
});

test("getResponsiveTuiLayout keeps compact chat windows bounded by available height", () => {
  const layout = getResponsiveTuiLayout({ columns: 100, rows: 28 });

  assert.equal(layout.compact, true);
  assert.equal(layout.showBanner, true);
  assert.equal(layout.threadHeight, 1);
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
  assert.equal(getPromptInputRowBudget({ columns: 120, rows: 48 }), 6);
  assert.equal(getPromptInputRowBudget({ columns: 160, rows: 80 }), 8);
});

test("estimateBannerRows counts the Welcome row in each banner layout", () => {
  assert.equal(estimateBannerRows({ columns: 140, detailsCount: 3 }), 8);
  assert.equal(estimateBannerRows({ columns: 100, detailsCount: 3 }), 12);
  assert.equal(estimateBannerRows({ columns: 80, detailsCount: 3 }), 5);
});

test("shouldUseSplitChatLayout only enables the side context on roomy terminals", () => {
  assert.equal(shouldUseSplitChatLayout({ columns: 160, rows: 48 }), true);
  assert.equal(shouldUseSplitChatLayout({ columns: 132, rows: 40 }), true);
  assert.equal(shouldUseSplitChatLayout({ columns: 118, rows: 36 }), true);
  assert.equal(shouldUseSplitChatLayout({ columns: 108, rows: 48 }), false);
  assert.equal(shouldUseSplitChatLayout({ columns: 111, rows: 48 }), false);
  assert.equal(shouldUseSplitChatLayout({ columns: 160, rows: 33 }), false);
});

test("getChatResponsiveMode separates wide, medium, and narrow chat layouts", () => {
  assert.equal(getChatResponsiveMode({ columns: 160, rows: 48 }), "wide");
  assert.equal(getChatResponsiveMode({ columns: 118, rows: 36 }), "medium");
  assert.equal(getChatResponsiveMode({ columns: 96, rows: 36 }), "narrow");
  assert.equal(getChatResponsiveMode({ columns: 160, rows: 31 }), "narrow");
});

test("getContextRailWidth keeps the rail useful without stealing the thread", () => {
  assert.equal(getContextRailWidth({ columns: 160, rows: 48 }), 40);
  assert.equal(getContextRailWidth({ columns: 118, rows: 36 }), 30);
  assert.equal(getContextRailWidth({ columns: 96, rows: 36 }), 0);
});

test("estimateComposerRows budgets a flatter dock than the framed panel", () => {
  assert.equal(
    estimateComposerRows({
      inputRows: 4,
      suggestionRows: 1,
      includeControls: false,
      variant: "panel",
    }),
    8
  );
  assert.equal(
    estimateComposerRows({
      inputRows: 4,
      suggestionRows: 1,
      includeControls: false,
      variant: "dock",
    }),
    7
  );
});
