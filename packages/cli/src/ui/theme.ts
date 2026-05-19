type InkColor = string | undefined;

const hasColor = () =>
  !process.env.NO_COLOR && process.env.TERM !== "dumb";

const terminalBackground = (): "light" | "dark" | "unknown" => {
  const colorFgBg = process.env.COLORFGBG;
  if (!colorFgBg) {
    return "unknown";
  }

  const bg = Number(colorFgBg.split(";").pop());
  if (!Number.isFinite(bg)) {
    return "unknown";
  }

  return bg >= 7 && bg <= 15 ? "light" : "dark";
};

const isLightTerminal = () => terminalBackground() === "light";

const color = (dark: string, light: string): InkColor => {
  if (!hasColor()) {
    return undefined;
  }
  return isLightTerminal() ? light : dark;
};

export const terminalTheme = {
  brand: color("cyanBright", "blue"),
  accent: color("magentaBright", "magenta"),
  focus: color("cyanBright", "blue"),
  selected: color("greenBright", "green"),
  success: color("greenBright", "green"),
  muted: color("gray", "gray"),
  /** Inline ghost / autosuggest — distinct from user text and from gray-muted UI chrome */
  inputGhost: color("magenta", "blue"),
  warning: color("yellowBright", "magenta"),
  danger: color("redBright", "red"),
  cursor: color("cyanBright", "blue"),
};

export const shouldUseColor = hasColor;

export const raisedButtonStyle = {
  border: "round" as const,
  activeMarker: "●",
  inactiveMarker: "○",
};
