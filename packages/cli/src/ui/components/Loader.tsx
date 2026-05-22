import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { terminalTheme } from "../theme.js";
import { getLoaderStepMarker, getSpinnerFrames } from "./Spinner.js";

export interface LoaderProps {
  step: number;
  steps: string[];
  animate?: boolean;
}

export const LOADER_FRAME_INTERVAL_MS = 1000;

export const Loader: React.FC<LoaderProps> = ({
  step,
  steps,
  animate = true,
}) => {
  const [frame, setFrame] = useState(0);
  const frames = getSpinnerFrames("line");

  useEffect(() => {
    if (!animate) return;
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length);
    }, LOADER_FRAME_INTERVAL_MS);
    return () => clearInterval(id);
  }, [animate, frames.length]);

  const activeFrame = animate ? frame : 0;

  return (
    <Box flexDirection="column" gap={1}>
      {steps.map((label, idx) => {
        const isActive = idx === step;
        const isComplete = idx < step;
        const prefix = getLoaderStepMarker(
          isComplete ? "complete" : isActive ? "active" : "pending",
          activeFrame
        );
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
