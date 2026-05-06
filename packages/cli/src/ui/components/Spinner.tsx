import React from "react";
import { Text } from "ink";

interface SpinnerProps {
  type?: "dots" | "line" | "pulse";
  animate?: boolean;
}

const dotFrames = ["·  ", "·· ", "···"];
const lineFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const pulseFrames = ["◐", "◓", "◑", "◒"];

export const SPINNER_FRAME_INTERVAL_MS = 1000;

export const shouldAnimateSpinner = (animate = true): boolean => animate;

export const Spinner: React.FC<SpinnerProps> = ({ type = "dots", animate = true }) => {
  const [frame, setFrame] = React.useState(0);
  const frames = type === "dots" ? dotFrames : type === "pulse" ? pulseFrames : lineFrames;

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

  return <Text>{frames[frame]}</Text>;
};
