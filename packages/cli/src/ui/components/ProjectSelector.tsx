import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { terminalTheme } from "../theme.js";

interface ProjectSelectorItem<T> {
  label: string;
  value: T;
}

interface ProjectSelectorProps<T> {
  items: ProjectSelectorItem<T>[];
  onSubmit: (selected: T[]) => void;
  limit?: number;
  multiple?: boolean;
}

export function ProjectSelector<T>({
  items,
  onSubmit,
  limit = 5,
  multiple = false,
}: ProjectSelectorProps<T>) {
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(items.length > 0 ? [0] : [])
  );
  const [highlighted, setHighlighted] = useState(0);

  useEffect(() => {
    setHighlighted((current) => Math.min(current, Math.max(0, items.length - 1)));
    setSelected((current) => {
      const next = new Set(
        Array.from(current).filter((index) => index >= 0 && index < items.length)
      );
      if (next.size === 0 && items.length > 0) {
        next.add(0);
      }
      return next;
    });
  }, [items.length]);

  useInput((input, key) => {
    if (items.length === 0) {
      return;
    }

    if (key.upArrow) {
      setHighlighted((h) => Math.max(0, h - 1));
    } else if (key.downArrow) {
      setHighlighted((h) => Math.min(items.length - 1, h + 1));
    } else if (input === " ") {
      if (multiple) {
        setSelected((s) => {
          const newSet = new Set(s);
          if (newSet.has(highlighted)) {
            newSet.delete(highlighted);
          } else {
            newSet.add(highlighted);
          }
          return newSet;
        });
      } else {
        setSelected(new Set([highlighted]));
      }
    } else if (key.return) {
      const selectedIndexes = multiple ? Array.from(selected) : [highlighted];
      const selectedItems = selectedIndexes.map((idx) => items[idx]).filter(Boolean);
      if (selectedItems.length > 0) {
        onSubmit(selectedItems.map((item) => item.value));
      }
    }
  });

  const visibleCount = Math.max(1, limit);
  const windowStart = Math.min(
    Math.max(0, highlighted - Math.floor(visibleCount / 2)),
    Math.max(0, items.length - visibleCount)
  );
  const visibleItems = items.slice(windowStart, windowStart + visibleCount);

  if (items.length === 0) {
    return <Text dimColor>No projects available.</Text>;
  }

  return (
    <Box flexDirection="column" gap={0}>
      {visibleItems.map((item, idx) => {
        const actualIndex = windowStart + idx;
        const isSelected = multiple
          ? selected.has(actualIndex)
          : highlighted === actualIndex;
        const isHighlighted = highlighted === actualIndex;
        const marker = isHighlighted ? ">" : isSelected ? "*" : " ";
        return (
          <Text
            key={`${actualIndex}-${item.label}`}
            bold={isHighlighted || isSelected}
            color={
              isSelected
                ? terminalTheme.success
                : isHighlighted
                  ? terminalTheme.brand
                  : undefined
            }
          >
            {marker} {item.label}
            {isSelected ? " [current]" : ""}
          </Text>
        );
      })}
      <Text dimColor>
        {multiple
          ? "Use arrows to navigate, Space to toggle, Enter to confirm"
          : "Use arrows to navigate and Enter to select"}
      </Text>
      {items.length > visibleItems.length ? (
        <Text dimColor>
          Showing {windowStart + 1}-{windowStart + visibleItems.length} of {items.length}
        </Text>
      ) : null}
    </Box>
  );
}


