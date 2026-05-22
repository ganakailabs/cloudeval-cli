import React from "react";
import { Text } from "ink";
import { terminalTheme } from "../theme.js";

const SLASH_COMMAND_PATTERN = /(\/[a-z][a-z0-9_-]*)/gi;

export const InputHelpText: React.FC<{ text: string }> = ({ text }) => {
  const parts = text.split(SLASH_COMMAND_PATTERN);
  if (parts.length === 1) {
    return (
      <Text dimColor wrap="truncate">
        {text}
      </Text>
    );
  }

  return (
    <Text wrap="truncate">
      {parts.map((part, index) => {
        if (part.startsWith("/")) {
          return (
            <Text key={`${part}-${index}`} color={terminalTheme.accent} bold>
              {part}
            </Text>
          );
        }
        return (
          <Text key={`${part}-${index}`} dimColor>
            {part}
          </Text>
        );
      })}
    </Text>
  );
};
