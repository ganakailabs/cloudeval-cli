import React from "react";
import { Box, Text } from "ink";

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

  // Create scrollbar visual representation
  const scrollbarLines: string[] = [];
  for (let i = 0; i < scrollbarHeight; i++) {
    if (i >= thumbPosition && i < thumbPosition + thumbHeight) {
      // Thumb (filled part)
      scrollbarLines.push("█");
    } else {
      // Track (empty part)
      scrollbarLines.push("░");
    }
  }

  return (
    <Box flexDirection="column" marginLeft={1}>
      {scrollbarLines.map((line, idx) => (
        <Text key={idx} color="gray">
          {line}
        </Text>
      ))}
    </Box>
  );
};
