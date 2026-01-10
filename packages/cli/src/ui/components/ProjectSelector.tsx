import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";

interface ProjectSelectorItem<T> {
  label: string;
  value: T;
}

interface ProjectSelectorProps<T> {
  items: ProjectSelectorItem<T>[];
  onSubmit: (selected: T[]) => void;
  limit?: number;
}

export function ProjectSelector<T>({
  items,
  onSubmit,
  limit = 5,
}: ProjectSelectorProps<T>) {
  const [selected, setSelected] = useState<Set<number>>(new Set([0]));
  const [highlighted, setHighlighted] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setHighlighted((h) => Math.max(0, h - 1));
    } else if (key.downArrow) {
      setHighlighted((h) => Math.min(items.length - 1, h + 1));
    } else if (input === " ") {
      // Toggle selection
      setSelected((s) => {
        const newSet = new Set(s);
        if (newSet.has(highlighted)) {
          newSet.delete(highlighted);
        } else {
          newSet.add(highlighted);
        }
        return newSet;
      });
    } else if (key.return) {
      // Submit selected items
      const selectedItems = Array.from(selected)
        .map((idx) => items[idx])
        .filter(Boolean);
      if (selectedItems.length > 0) {
        onSubmit(selectedItems.map((item) => item.value));
      }
    }
  });

  const visibleItems = items.slice(0, limit);

  return (
    <Box flexDirection="column" gap={0}>
      {visibleItems.map((item, idx) => {
        const isSelected = selected.has(idx);
        const isHighlighted = highlighted === idx;
        return (
          <Text key={idx}>
            {isSelected ? "✓" : " "} {isHighlighted ? ">" : " "} {item.label}
          </Text>
        );
      })}
      <Text dimColor>
        Use ↑↓ to navigate, Space to select, Enter to confirm
      </Text>
    </Box>
  );
}





