import React from "react";
import { Box, Text, useInput } from "ink";
import { terminalTheme } from "../theme.js";

export interface SelectPanelItem<T> {
  label: string;
  value: T;
  description?: string;
}

interface SelectPanelProps<T> {
  title: string;
  items: SelectPanelItem<T>[];
  selectedIndex?: number;
  onSubmit: (item: SelectPanelItem<T>) => void;
  onCancel: () => void;
  limit?: number;
}

export function SelectPanel<T>({
  title,
  items,
  selectedIndex = 0,
  onSubmit,
  onCancel,
  limit = 8,
}: SelectPanelProps<T>) {
  const normalizedSelectedIndex = Math.min(
    Math.max(selectedIndex, 0),
    Math.max(items.length - 1, 0)
  );
  const [highlighted, setHighlighted] = React.useState(() =>
    normalizedSelectedIndex
  );

  React.useEffect(() => {
    setHighlighted(Math.min(Math.max(selectedIndex, 0), Math.max(items.length - 1, 0)));
  }, [items.length, selectedIndex]);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (!items.length) {
      return;
    }
    if (key.upArrow) {
      setHighlighted((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setHighlighted((current) => Math.min(items.length - 1, current + 1));
      return;
    }
    if (key.return) {
      onSubmit(items[highlighted]);
    }
  });

  const visibleCount = Math.max(1, limit);
  const windowStart = Math.min(
    Math.max(0, highlighted - Math.floor(visibleCount / 2)),
    Math.max(0, items.length - visibleCount)
  );
  const visibleItems = items.slice(windowStart, windowStart + visibleCount);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={terminalTheme.brand} padding={1}>
      <Text bold color={terminalTheme.brand}>{title}</Text>
      {items.length === 0 ? (
        <Text dimColor>No options available.</Text>
      ) : (
        visibleItems.map((item, offset) => {
          const index = windowStart + offset;
          const isHighlighted = index === highlighted;
          const isSelected = index === normalizedSelectedIndex;
          const marker = isHighlighted ? "▸" : isSelected ? "•" : " ";
          return (
            <Box key={`${index}-${item.label}`} flexDirection="column">
              <Text
                bold={isHighlighted || isSelected}
                color={
                  isSelected
                    ? terminalTheme.success
                    : isHighlighted
                      ? terminalTheme.brand
                      : undefined
                }
              >
                {marker}{" "}
                {item.label}
                {isSelected ? " current" : ""}
              </Text>
              {isHighlighted && item.description ? (
                <Text dimColor>  {item.description}</Text>
              ) : null}
            </Box>
          );
        })
      )}
      <Text dimColor>Use Up/Down, Enter to select, Esc to cancel.</Text>
    </Box>
  );
}
