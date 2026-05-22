import React from "react";
import { Text } from "ink";
import { classifyNoticeTone } from "../noticeTone.js";
import { terminalTheme } from "../theme.js";

const toneColor = (tone: ReturnType<typeof classifyNoticeTone>): string | undefined => {
  switch (tone) {
    case "success":
      return terminalTheme.success;
    case "warning":
      return terminalTheme.warning;
    case "danger":
      return terminalTheme.danger;
    case "info":
      return terminalTheme.secondary;
    default:
      return terminalTheme.muted;
  }
};

export const NoticeLine: React.FC<{ message: string }> = ({ message }) => {
  const tone = classifyNoticeTone(message);
  const color = toneColor(tone);
  const bold = tone === "success" || tone === "danger";

  return (
    <Text wrap="wrap" color={color} bold={bold}>
      {message}
    </Text>
  );
};
