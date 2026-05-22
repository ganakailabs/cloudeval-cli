import React from "react";
import { Text } from "ink";
import { terminalTheme } from "../theme.js";

interface SpinnerProps {
  type?: "dots" | "line" | "pulse";
  animate?: boolean;
}

const spinnerFrames = ["◜", "◠", "◝", "◞", "◡", "◟"];

export const SPINNER_FRAME_INTERVAL_MS = 1000;

export const shouldAnimateSpinner = (animate = true): boolean => animate;

export const getSpinnerFrames = (_type: SpinnerProps["type"] = "line"): string[] =>
  spinnerFrames;

export const getLoaderStepMarker = (
  state: "active" | "complete" | "pending",
  frameIndex = 0
): string => {
  if (state === "complete") {
    return "✓";
  }
  if (state === "pending") {
    return "·";
  }
  const frames = getSpinnerFrames("line");
  return frames[Math.abs(frameIndex) % frames.length] ?? frames[0];
};

export const Spinner: React.FC<SpinnerProps> = ({ type = "dots", animate = true }) => {
  const [frame, setFrame] = React.useState(0);
  const frames = getSpinnerFrames(type);

  React.useEffect(() => {
    if (!shouldAnimateSpinner(animate)) {
      setFrame(0);
      return;
    }
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length);
    }, SPINNER_FRAME_INTERVAL_MS);
    return () => clearInterval(id);
  }, [animate, frames.length]);

  return <Text color={terminalTheme.brand}>{frames[frame]}</Text>;
};
