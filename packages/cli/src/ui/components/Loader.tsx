import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";

export interface LoaderProps {
  step: number;
  steps: string[];
  animate?: boolean;
}

const brailleFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const asciiFrames = [".  ", ".. ", "...", " | "];

const supportsUnicode = () =>
  process.platform !== "win32" &&
  !process.env.CLOUDEVAL_NO_UNICODE &&
  !process.env.FORCE_ASCII;

export const Loader: React.FC<LoaderProps> = ({
  step,
  steps,
  animate = true,
}) => {
  const [frame, setFrame] = useState(0);
  const frames = supportsUnicode() ? brailleFrames : asciiFrames;

  useEffect(() => {
    if (!animate) return;
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length);
    }, 100);
    return () => clearInterval(id);
  }, [animate, frames.length]);

  const spinner = animate ? frames[frame] : "•";

  return (
    <Box flexDirection="column" gap={1}>
      {steps.map((label, idx) => {
        const isActive = idx === step;
        const isComplete = idx < step;
        const prefix = isComplete ? "✔" : isActive ? spinner : " ";
        const color = isComplete ? "green" : isActive ? "cyan" : undefined;
        return (
          <Text key={label} color={color}>
            {prefix} {label}
          </Text>
        );
      })}
    </Box>
  );
};
