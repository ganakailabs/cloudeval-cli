import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { sanitizeTerminalInput } from "../inputSanitizer.js";
import { truncateForTerminal } from "../layout.js";
import { raisedButtonStyle, terminalTheme } from "../theme.js";
import {
  workspaceTabFromPromptChange,
  type WorkspaceTab,
} from "../workspaceTabs.js";

export interface InputBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  followUps?: string[];
  followUpsLabel?: string;
  focusedFollowUpIndex?: number;
  followUpsActive?: boolean;
  terminalColumns?: number;
  onTabShortcut?: (tab: WorkspaceTab) => void;
}

export const InputBox: React.FC<InputBoxProps> = ({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = "Ask Cloudeval...",
  followUps = [],
  followUpsLabel = "Follow-ups",
  focusedFollowUpIndex,
  followUpsActive = false,
  terminalColumns = 100,
  onTabShortcut,
}) => {
  const buttonLimit = Math.max(24, Math.min(72, Math.floor((terminalColumns - 14) / 2)));
  const handleChange = (nextValue: string) => {
    const cleanedValue = sanitizeTerminalInput(nextValue);
    const shortcutTab = onTabShortcut
      ? workspaceTabFromPromptChange(value, cleanedValue)
      : undefined;
    if (shortcutTab) {
      onTabShortcut?.(shortcutTab);
      return;
    }
    onChange(cleanedValue);
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={followUpsActive ? terminalTheme.brand : undefined} padding={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>Prompt</Text>
        <Text dimColor>Enter send | Ctrl+C quit</Text>
      </Box>
      {followUps.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{followUpsLabel}</Text>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {followUps.map((question, index) => {
              const focused = followUpsActive && focusedFollowUpIndex === index;
              return (
                <Box
                  key={`${index}-${question}`}
                  borderStyle={raisedButtonStyle.border}
                  borderColor={focused ? terminalTheme.brand : terminalTheme.muted}
                  paddingX={1}
                >
                  <Text
                    color={focused ? terminalTheme.brand : undefined}
                    bold={focused}
                    inverse={focused}
                  >
                    {focused ? raisedButtonStyle.activeMarker : raisedButtonStyle.inactiveMarker}{" "}
                    {index + 1}. {truncateForTerminal(question, buttonLimit)}
                  </Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      ) : null}
      <TextInput
        value={value}
        onChange={handleChange}
        onSubmit={(nextValue) => onSubmit(sanitizeTerminalInput(nextValue))}
        placeholder={placeholder}
        focus={!disabled}
      />
    </Box>
  );
};
