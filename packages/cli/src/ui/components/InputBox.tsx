import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { sanitizeTerminalMultilineInput } from "../inputSanitizer.js";
import { shouldSubmitInputOnReturn } from "../inputSubmitBehavior.js";
import {
  DEFAULT_INPUT_MAX_ROWS,
  DEFAULT_INPUT_MIN_ROWS,
  getInputViewport,
} from "../inputViewport.js";
import { getTuiKeyBindings } from "../keyBindings.js";
import { raisedButtonStyle, terminalTheme } from "../theme.js";
import {
  workspaceTabFromPromptChange,
  type WorkspaceTab,
} from "../workspaceTabs.js";
import { TitledBox } from "./TitledBox.js";

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
  footerControls?: React.ReactNode;
  helpText?: string;
  actionLabel?: string;
  actionHint?: string;
  actionTone?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  minInputRows?: number;
  maxInputRows?: number;
  scrollOffset?: number;
  onTabShortcut?: (tab: WorkspaceTab) => void;
  blinkCursor?: boolean;
  ghostText?: string;
}

export const shouldAnimateInputCursor = ({
  disabled,
  blinkCursor = false,
}: {
  disabled?: boolean;
  blinkCursor?: boolean;
}): boolean => !disabled && blinkCursor;

const Scrollbar: React.FC<{ totalRows: number; visibleRows: number; startRow: number }> = ({
  totalRows,
  visibleRows,
  startRow,
}) => {
  if (totalRows <= visibleRows) {
    return null;
  }
  const maxStart = Math.max(1, totalRows - visibleRows);
  const thumbIndex = Math.min(
    visibleRows - 1,
    Math.max(0, Math.round((startRow / maxStart) * (visibleRows - 1)))
  );
  return (
    <Box flexDirection="column" marginLeft={1}>
      {Array.from({ length: visibleRows }, (_, index) => (
        <Text key={index} color={index === thumbIndex ? terminalTheme.brand : terminalTheme.muted}>
          {index === thumbIndex ? "┃" : "│"}
        </Text>
      ))}
    </Box>
  );
};

export interface FollowUpRowViewportItem {
  index: number;
  question: string;
  label: string;
  width: number;
}

export interface FollowUpRowViewport {
  items: FollowUpRowViewportItem[];
  clippedStart: boolean;
  clippedEnd: boolean;
  rowCount: 1;
}

const truncateInline = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 3) {
    return ".".repeat(Math.max(0, maxLength));
  }
  return `${value.slice(0, maxLength - 3)}...`;
};

export const getFollowUpRowViewport = ({
  followUps,
  focusedFollowUpIndex,
  terminalColumns,
}: {
  followUps: string[];
  focusedFollowUpIndex?: number;
  terminalColumns: number;
}): FollowUpRowViewport => {
  if (!followUps.length) {
    return { items: [], clippedStart: false, clippedEnd: false, rowCount: 1 };
  }

  const availableWidth = Math.max(24, terminalColumns - 8);
  const maxLabelLength = Math.max(
    12,
    Math.min(32, Math.floor(availableWidth / 2) - 5)
  );
  const targetIndex = Math.min(
    followUps.length - 1,
    Math.max(0, focusedFollowUpIndex ?? 0)
  );
  const items = followUps.map((question, index) => {
    const prefix = `${index + 1}. `;
    const label = `${prefix}${question}`;
    return {
      index,
      question,
      label,
      width: label.length + 2,
    } satisfies FollowUpRowViewportItem;
  });
  const fullWidth = items.reduce(
    (total, item, index) => total + item.width + (index > 0 ? 1 : 0),
    0
  );
  if (fullWidth <= availableWidth) {
    return {
      items,
      clippedStart: false,
      clippedEnd: false,
      rowCount: 1,
    };
  }

  const truncatedItems = followUps.map((question, index) => {
    const prefix = `${index + 1}. `;
    const label = `${prefix}${truncateInline(
      question,
      Math.max(4, maxLabelLength - prefix.length)
    )}`;
    return {
      index,
      question,
      label,
      width: label.length + 2,
    } satisfies FollowUpRowViewportItem;
  });

  let start = 0;
  let usedWidth = 0;
  for (let index = 0; index <= targetIndex; index++) {
    usedWidth += truncatedItems[index].width + (index > start ? 1 : 0);
    while (usedWidth > availableWidth && start < targetIndex) {
      usedWidth -= truncatedItems[start].width + (start + 1 <= index ? 1 : 0);
      start++;
    }
  }

  let end = targetIndex + 1;
  while (end < truncatedItems.length) {
    const nextWidth = truncatedItems[end].width + (end > start ? 1 : 0);
    if (usedWidth + nextWidth > availableWidth) {
      break;
    }
    usedWidth += nextWidth;
    end++;
  }

  return {
    items: truncatedItems.slice(start, end),
    clippedStart: start > 0,
    clippedEnd: end < truncatedItems.length,
    rowCount: 1,
  };
};

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
  footerControls,
  helpText,
  actionLabel,
  actionHint,
  actionTone,
  onAction,
  actionDisabled = false,
  minInputRows = DEFAULT_INPUT_MIN_ROWS,
  maxInputRows = DEFAULT_INPUT_MAX_ROWS,
  scrollOffset,
  onTabShortcut,
  blinkCursor = false,
  ghostText,
}) => {
  const [cursorVisible, setCursorVisible] = useState(true);
  const keyBindings = getTuiKeyBindings();
  const compact = terminalColumns < 78;
  const defaultHelpText = `${keyBindings.submit} | ${keyBindings.newline} | ${keyBindings.quit}`;
  const resolvedHelpText = helpText ?? defaultHelpText;
  const showHeaderRow = followUps.length > 0 || resolvedHelpText.length > 0;
  const followUpViewport = getFollowUpRowViewport({
    followUps,
    focusedFollowUpIndex,
    terminalColumns,
  });
  const actionButtonWidth = actionLabel ? actionLabel.length + 4 : 0;
  const inputWidth = Math.max(
    20,
    terminalColumns - 14 - (compact ? 0 : actionButtonWidth)
  );
  const inputViewport = getInputViewport({
    value,
    width: inputWidth,
    minRows: minInputRows,
    maxRows: maxInputRows,
    scrollOffset,
  });
  const inputRows = inputViewport.rows;
  const visibleRowCount = inputViewport.visibleRowCount;
  const startRow = inputViewport.startRow;
  const visibleRows = inputViewport.visibleRows;

  useEffect(() => {
    if (!shouldAnimateInputCursor({ disabled, blinkCursor })) {
      setCursorVisible(true);
      return;
    }
    const timer = setInterval(() => setCursorVisible((current) => !current), 520);
    return () => clearInterval(timer);
  }, [blinkCursor, disabled, value]);

  const handleChange = (nextValue: string) => {
    const cleanedValue = sanitizeTerminalMultilineInput(nextValue);
    const shortcutTab = onTabShortcut
      ? workspaceTabFromPromptChange(value, cleanedValue)
      : undefined;
    if (shortcutTab) {
      onTabShortcut?.(shortcutTab);
      return;
    }
    onChange(cleanedValue);
  };

  const insertText = (nextText: string) => {
    const cleanedText = sanitizeTerminalMultilineInput(nextText);
    if (!cleanedText) {
      return;
    }
    handleChange(`${value}${cleanedText}`);
  };

  const insertNewline = () => handleChange(`${value}\n`);

  useInput(
    (input, key) => {
      if (disabled) {
        return;
      }
      if (key.ctrl && input.toLowerCase() === "c") {
        return;
      }
      if (key.return) {
        if (key.meta || key.ctrl) {
          insertNewline();
          return;
        }
        if (!shouldSubmitInputOnReturn(value)) {
          return;
        }
        onSubmit(sanitizeTerminalMultilineInput(value));
        return;
      }
        if (key.ctrl && input.toLowerCase() === "j") {
          insertNewline();
          return;
        }
        if (key.escape && onAction && actionLabel?.toLowerCase().includes("cancel")) {
          onAction();
          return;
        }
      if (key.backspace || key.delete) {
        handleChange(value.slice(0, -1));
        return;
      }
      if (
        key.upArrow ||
        key.downArrow ||
        key.leftArrow ||
        key.rightArrow ||
        key.tab ||
        key.escape
      ) {
        return;
      }
      insertText(input);
    },
    { isActive: !disabled }
  );

  return (
    <TitledBox
      title="Prompt"
      borderStyle="round"
      borderColor={followUpsActive ? terminalTheme.brand : terminalTheme.muted}
      padding={1}
    >
      {showHeaderRow ? (
        <Box
          flexDirection={compact ? "column" : "row"}
          justifyContent="space-between"
          columnGap={1}
        >
          <Text dimColor>
            {followUps.length ? followUpsLabel : ""}
          </Text>
          {resolvedHelpText ? (
            <Text dimColor wrap="truncate">
              {resolvedHelpText}
            </Text>
          ) : null}
        </Box>
      ) : null}
      {followUps.length ? (
        <Box flexDirection="row" columnGap={1} marginTop={compact ? 1 : 0}>
          {followUpViewport.clippedStart ? <Text dimColor>{"<--"}</Text> : null}
          {followUpViewport.items.map(({ question, index, label }) => {
            const focused = followUpsActive && focusedFollowUpIndex === index;
            return (
              <Text
                key={`${index}-${question}`}
                color={focused ? terminalTheme.brand : undefined}
                bold={focused}
              >
                {focused ? raisedButtonStyle.activeMarker : raisedButtonStyle.inactiveMarker}{" "}
                {label}
              </Text>
            );
          })}
          {followUpViewport.clippedEnd ? <Text dimColor>{"-->"}</Text> : null}
        </Box>
      ) : null}
      <TitledBox
        title="Input"
        flexDirection={compact ? "column" : "row"}
        borderStyle="single"
        borderColor={disabled ? terminalTheme.muted : terminalTheme.brand}
        padding={0}
        paddingX={1}
        marginTop={1}
      >
        <Box flexDirection="column" flexGrow={1}>
          {!value ? (
            <Text dimColor wrap="truncate">
              <Text color={cursorVisible ? terminalTheme.brand : undefined}>
                {cursorVisible ? "▌" : " "}
              </Text>{" "}
              {placeholder}
            </Text>
          ) : (
            visibleRows.map((line, index) => {
              const isLastValueRow = startRow + index === inputRows.length - 1;
              return (
                <Text key={`${startRow}-${index}`} wrap="truncate">
                  {line}
                  {isLastValueRow ? (
                    <>
                      <Text
                        dimColor
                        italic
                        color={terminalTheme.inputGhost}
                      >
                        {ghostText ?? ""}
                      </Text>
                      <Text color={cursorVisible ? terminalTheme.brand : undefined}>
                        {cursorVisible ? "▌" : " "}
                      </Text>
                    </>
                  ) : null}
                </Text>
              );
            })
          )}
        </Box>
        <Scrollbar
          totalRows={inputRows.length}
          visibleRows={visibleRowCount}
          startRow={startRow}
        />
        {actionLabel ? (
          <Box
            marginLeft={compact ? 0 : 1}
            marginTop={compact ? 1 : 0}
            justifyContent={compact ? "flex-end" : "center"}
            flexDirection="row"
          >
            <Box
              borderStyle={raisedButtonStyle.border}
              borderColor={
                actionDisabled
                  ? terminalTheme.muted
                  : actionTone ?? terminalTheme.brand
              }
              paddingX={1}
            >
              <Text
                bold={!actionDisabled}
                color={
                  actionDisabled
                    ? terminalTheme.muted
                    : actionTone ?? terminalTheme.brand
                }
              >
                {actionLabel}
              </Text>
            </Box>
          </Box>
        ) : null}
      </TitledBox>
      {actionHint ? (
        <Text dimColor wrap="truncate">
          {actionHint}
        </Text>
      ) : null}
      {footerControls ? (
        <Box flexDirection="column" marginTop={1}>
          {footerControls}
        </Box>
      ) : null}
    </TitledBox>
  );
};
