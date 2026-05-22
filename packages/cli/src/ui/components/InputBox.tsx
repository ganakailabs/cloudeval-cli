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
  title?: string;
  variant?: "dock" | "panel";
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
  inputActive?: boolean;
  onBlurRequest?: () => void;
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
  onAction?: () => void;
  minInputRows?: number;
  maxInputRows?: number;
  scrollOffset?: number;
  onTabShortcut?: (tab: WorkspaceTab) => void;
  blinkCursor?: boolean;
  ghostText?: string;
  commandCompletions?: CommandCompletionItem[];
  focusedCommandCompletionIndex?: number;
  commandCompletionsActive?: boolean;
  onCommandCompletionSubmit?: (command: CommandCompletionItem) => void;
}

export const shouldAnimateInputCursor = ({
  disabled,
  inputActive = true,
  blinkCursor = false,
}: {
  disabled?: boolean;
  inputActive?: boolean;
  blinkCursor?: boolean;
}): boolean => !disabled && inputActive && blinkCursor;

export const shouldBlinkPromptCursor = ({
  animationsEnabled,
  inputActive = true,
  busy = false,
  selectorOpen = false,
  searching = false,
}: {
  animationsEnabled: boolean;
  inputActive?: boolean;
  busy?: boolean;
  selectorOpen?: boolean;
  searching?: boolean;
}): boolean =>
  Boolean(animationsEnabled && inputActive && !selectorOpen && !searching);

export const getInputCursorColor = ({
  disabled,
  inputActive = true,
  cursorVisible = true,
}: {
  disabled?: boolean;
  inputActive?: boolean;
  cursorVisible?: boolean;
}) => {
  if (disabled || !inputActive) {
    return terminalTheme.muted;
  }
  return cursorVisible ? terminalTheme.cursor : terminalTheme.accent;
};

export const getInputCursorGlyph = ({
  inputActive = true,
  cursorVisible = true,
}: {
  inputActive?: boolean;
  cursorVisible?: boolean;
}): string => {
  if (!inputActive) {
    return " ";
  }
  return cursorVisible ? "▌" : "▏";
};

export interface PromptDisplayRow {
  line: string;
  showPromptPrefix: boolean;
  showCursor: boolean;
  isFiller: boolean;
}

export interface CommandCompletionItem {
  name: string;
  description?: string;
  aliases?: string[];
}

export const getPromptDisplayRows = ({
  visibleRows,
  startRow,
  inputRowCount,
}: {
  visibleRows: string[];
  startRow: number;
  inputRowCount: number;
}): PromptDisplayRow[] =>
  visibleRows.map((line, index) => {
    const rowIndex = startRow + index;
    const isFiller = rowIndex >= inputRowCount;
    return {
      line,
      isFiller,
      showPromptPrefix: !isFiller,
      showCursor: !isFiller && rowIndex === inputRowCount - 1,
    };
  });

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
        <Text key={index} color={index === thumbIndex ? terminalTheme.focus : terminalTheme.muted}>
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

export const getCommandCompletionViewport = ({
  commands,
  focusedIndex = 0,
  terminalColumns,
}: {
  commands: CommandCompletionItem[];
  focusedIndex?: number;
  terminalColumns: number;
}): {
  items: Array<{ command: CommandCompletionItem; index: number; label: string; width: number }>;
  clippedStart: boolean;
  clippedEnd: boolean;
  rowCount: number;
} => {
  const availableWidth = Math.max(24, terminalColumns - 28);
  const activeIndex = commands.length
    ? Math.min(Math.max(0, focusedIndex), commands.length - 1)
    : 0;
  const items = commands.map((command, index) => {
    const label = `${index === activeIndex ? raisedButtonStyle.activeMarker : raisedButtonStyle.inactiveMarker} ${command.name}`;
    return { command, index, label, width: label.length };
  });
  if (!items.length) {
    return { items: [], clippedStart: false, clippedEnd: false, rowCount: 0 };
  }

  let start = activeIndex;
  let usedWidth = items[start]?.width ?? 0;
  while (start > 0) {
    const nextWidth = items[start - 1].width + 1;
    if (usedWidth + nextWidth > availableWidth) {
      break;
    }
    usedWidth += nextWidth;
    start--;
  }

  let end = activeIndex + 1;
  while (end < items.length) {
    const nextWidth = items[end].width + (end > start ? 1 : 0);
    if (usedWidth + nextWidth > availableWidth) {
      break;
    }
    usedWidth += nextWidth;
    end++;
  }

  return {
    items: items.slice(start, end),
    clippedStart: start > 0,
    clippedEnd: end < items.length,
    rowCount: 1,
  };
};

export const InputBox: React.FC<InputBoxProps> = ({
  title = "Prompt",
  variant = "panel",
  value,
  onChange,
  onSubmit,
  disabled = false,
  inputActive = true,
  onBlurRequest,
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
  onAction,
  minInputRows = DEFAULT_INPUT_MIN_ROWS,
  maxInputRows = DEFAULT_INPUT_MAX_ROWS,
  scrollOffset,
  onTabShortcut,
  blinkCursor = false,
  ghostText,
  commandCompletions = [],
  focusedCommandCompletionIndex,
  commandCompletionsActive = false,
  onCommandCompletionSubmit,
}) => {
  const [cursorVisible, setCursorVisible] = useState(true);
  const keyBindings = getTuiKeyBindings();
  const compact = terminalColumns < 78;
  const defaultHelpText = `${keyBindings.submit} | ${keyBindings.newline} | ${keyBindings.quit}`;
  const resolvedHelpText = helpText ?? defaultHelpText;
  const followUpViewport = getFollowUpRowViewport({
    followUps,
    focusedFollowUpIndex,
    terminalColumns,
  });
  const commandCompletionViewport = getCommandCompletionViewport({
    commands: commandCompletions,
    focusedIndex: focusedCommandCompletionIndex,
    terminalColumns,
  });
  const commandCompletionLine = [
    commandCompletionViewport.clippedStart ? "<--" : undefined,
    ...commandCompletionViewport.items.map((item) => item.label),
    commandCompletionViewport.clippedEnd ? "-->" : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const activeCommand =
    focusedCommandCompletionIndex === undefined
      ? undefined
      : commandCompletions[Math.min(
          Math.max(0, focusedCommandCompletionIndex),
          Math.max(0, commandCompletions.length - 1)
        )];
  const promptPrefix = ">";
  const inputWidth = Math.max(20, terminalColumns - 10);
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
  const promptRows = getPromptDisplayRows({
    visibleRows,
    startRow,
    inputRowCount: inputRows.length,
  });

  useEffect(() => {
    if (!shouldAnimateInputCursor({ disabled, inputActive, blinkCursor })) {
      setCursorVisible(true);
      return;
    }
    const timer = setInterval(() => setCursorVisible((current) => !current), 520);
    return () => clearInterval(timer);
  }, [blinkCursor, disabled, inputActive, value]);

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
        if (commandCompletionsActive && activeCommand && onCommandCompletionSubmit) {
          onCommandCompletionSubmit(activeCommand);
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
      if (key.escape) {
        onBlurRequest?.();
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
    { isActive: !disabled && inputActive }
  );

  const cursorGlyph = getInputCursorGlyph({ inputActive, cursorVisible });
  const cursorColor = getInputCursorColor({ disabled, inputActive, cursorVisible });
  const inputBorderColor = disabled
    ? terminalTheme.muted
    : followUpsActive || inputActive
      ? terminalTheme.focus
      : terminalTheme.muted;

  const content = (
    <>
      {followUps.length ? (
        <Text wrap="truncate">
          <Text dimColor>{`${followUpsLabel}: `}</Text>
          {followUpViewport.clippedStart ? <Text dimColor>{"<-- "}</Text> : null}
          {followUpViewport.items.map(({ question, index, label }) => {
            const focused = followUpsActive && focusedFollowUpIndex === index;
            return (
              <Text
                key={`${index}-${question}`}
                color={focused ? terminalTheme.focus : undefined}
                bold={focused}
              >
                {focused ? raisedButtonStyle.activeMarker : raisedButtonStyle.inactiveMarker}{" "}
                {label}{" "}
              </Text>
            );
          })}
          {followUpViewport.clippedEnd ? <Text dimColor>{"-->"}</Text> : null}
        </Text>
      ) : null}
      <Box
        flexDirection={compact ? "column" : "row"}
      >
        <Box flexDirection="column" flexGrow={1}>
          {!value ? (
            <Text wrap="truncate">
              <Text color={inputActive ? terminalTheme.brand : terminalTheme.muted}>
                {promptPrefix}{" "}
              </Text>
              <Text color={cursorColor}>
                {cursorGlyph}
              </Text>
              <Text dimColor>{` ${placeholder}`}</Text>
            </Text>
          ) : (
            promptRows.map((row, index) => {
              return (
                <Text key={`${startRow}-${index}`} wrap="truncate">
                  {row.showPromptPrefix ? (
                    <Text color={inputActive ? terminalTheme.brand : terminalTheme.muted}>
                      {promptPrefix}{" "}
                    </Text>
                  ) : (
                    <Text>{"  "}</Text>
                  )}
                  {row.line}
                  {row.showCursor ? (
                    <>
                      <Text
                        dimColor
                        italic
                        color={terminalTheme.inputGhost}
                      >
                        {ghostText ?? ""}
                      </Text>
                      <Text color={cursorColor}>
                        {cursorGlyph}
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
      </Box>
      {actionHint ? (
        <Text dimColor wrap="truncate">
          {actionHint}
        </Text>
      ) : resolvedHelpText ? (
        <Text dimColor wrap="truncate">
          {resolvedHelpText}
        </Text>
      ) : null}
      {commandCompletionViewport.items.length ? (
        <Text
          color={commandCompletionsActive ? terminalTheme.focus : terminalTheme.muted}
          bold={commandCompletionsActive}
          wrap="truncate"
        >
          {`/commands: ${commandCompletionLine} | Tab/↑↓ move | Enter choose`}
        </Text>
      ) : null}
      {footerControls ? (
        <Box flexDirection="column" marginTop={1}>
          {footerControls}
        </Box>
      ) : null}
    </>
  );

  if (variant === "dock") {
    return (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={inputBorderColor}
        paddingX={1}
      >
        {content}
      </Box>
    );
  }

  return (
    <TitledBox
      title={title}
      borderStyle="round"
      borderColor={inputBorderColor}
      padding={0}
      paddingX={1}
    >
      {content}
    </TitledBox>
  );
};
