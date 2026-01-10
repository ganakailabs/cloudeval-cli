import React from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

export interface InputBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export const InputBox: React.FC<InputBoxProps> = ({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = "Ask Cloudeval...",
}) => {
  useInput(
    (input, key) => {
      if (disabled) return;
      
      // Don't capture arrow keys, page up/down, home/end - let parent handle scrolling
      // Only handle return key for submission
      if (key.return) {
        if (key.shift) {
          onChange(`${value}\n`);
        } else {
          onSubmit(value);
        }
      }
      // Let all other keys (including arrow keys) pass through to parent for scrolling
    },
    { isActive: !disabled }
  );

  return (
    <Box flexDirection="column" borderStyle="round" padding={1}>
      <Text>
        Prompt (Enter to send, Shift+Enter for newline, Ctrl+C to quit)
      </Text>
      <TextInput
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        focus={!disabled}
      />
    </Box>
  );
};
