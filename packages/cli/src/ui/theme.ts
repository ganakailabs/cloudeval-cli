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
  brand: color("cyan", "blue"),
  accent: color("yellow", "blue"),
  success: color("green", "green"),
  muted: color("gray", "gray"),
  warning: color("yellow", "magenta"),
  danger: color("red", "red"),
  cursor: color("cyan", "blue"),
};

export const shouldUseColor = hasColor;
