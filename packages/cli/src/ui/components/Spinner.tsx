import React from "react";
import { Text } from "ink";

interface SpinnerProps {
  type?: "dots" | "line";
}

const dotFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const lineFrames = ["|", "/", "-", "\\"];

export const Spinner: React.FC<SpinnerProps> = ({ type = "dots" }) => {
  const [frame, setFrame] = React.useState(0);
  const frames = type === "dots" ? dotFrames : lineFrames;

  React.useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % frames.length);
    }, 100);
    return () => clearInterval(id);
  }, [frames.length]);

  return <Text>{frames[frame]}</Text>;
};





