import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { terminalTheme } from "../theme.js";

export interface LoaderProps {
  step: number;
  steps: string[];
  animate?: boolean;
}

const asciiFrames = ["[. ]", "[..]", "[--]", "[  ]"];
export const LOADER_FRAME_INTERVAL_MS = 1000;

export const Loader: React.FC<LoaderProps> = ({
  step,
  steps,
  animate = true,
}) => {
  const [frame, setFrame] = useState(0);
  const frames = asciiFrames;

  useEffect(() => {
    if (!animate) return;
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length);
    }, LOADER_FRAME_INTERVAL_MS);
    return () => clearInterval(id);
  }, [animate, frames.length]);

  const spinner = animate ? frames[frame] : "[..]";

  return (
    <Box flexDirection="column" gap={1}>
      {steps.map((label, idx) => {
        const isActive = idx === step;
        const isComplete = idx < step;
        const prefix = isComplete ? "[ok]" : isActive ? spinner : "[  ]";
        const color = isComplete
          ? terminalTheme.success
          : isActive
            ? terminalTheme.brand
            : undefined;
        return (
          <Text key={label} color={color}>
            {prefix} {label}
          </Text>
        );
      })}
    </Box>
  );
};
