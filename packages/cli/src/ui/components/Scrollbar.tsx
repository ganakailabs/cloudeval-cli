import React from "react";
import { Box, Text } from "ink";
import { terminalTheme } from "../theme.js";

interface ScrollbarProps {
  scrollOffset: number;
  contentHeight: number;
  viewportHeight: number;
}

export const Scrollbar: React.FC<ScrollbarProps> = ({
  scrollOffset,
  contentHeight,
  viewportHeight,
}) => {
  // Don't show scrollbar if content fits in viewport
  if (contentHeight <= viewportHeight) {
    return null;
  }

  // Calculate scrollbar position and size
  const scrollbarHeight = viewportHeight;
  const maxScroll = contentHeight - viewportHeight;
  const scrollRatio = maxScroll > 0 ? scrollOffset / maxScroll : 0;
  const thumbHeight = Math.max(1, Math.floor((viewportHeight / contentHeight) * scrollbarHeight));
  const thumbPosition = Math.floor((scrollbarHeight - thumbHeight) * scrollRatio);

  // Keep the rail to a single fixed-width column so it never bleeds into content.
  const scrollbarLines: string[] = [];
  for (let i = 0; i < scrollbarHeight; i++) {
    if (i >= thumbPosition && i < thumbPosition + thumbHeight) {
      scrollbarLines.push("█");
    } else {
      scrollbarLines.push("│");
    }
  }

  return (
    <Box flexDirection="column" marginLeft={1} flexShrink={0} width={1}>
      {scrollbarLines.map((line, idx) => (
        <Text
          key={idx}
          color={line === "█" ? terminalTheme.brand : terminalTheme.muted}
        >
          {line}
        </Text>
      ))}
    </Box>
  );
};
