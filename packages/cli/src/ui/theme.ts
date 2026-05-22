type InkColor = string | undefined;

export const terminalPalette = {
  brand: { dark: "cyanBright", light: "blue" },
  accent: { dark: "yellowBright", light: "yellow" },
  focus: { dark: "yellowBright", light: "yellow" },
  secondary: { dark: "blueBright", light: "blue" },
  citation: { dark: "yellowBright", light: "yellow" },
  selected: { dark: "yellowBright", light: "yellow" },
  selectedBackground: { dark: "yellow", light: "yellow" },
  userName: { dark: "cyanBright", light: "blue" },
  aiName: { dark: "magentaBright", light: "magenta" },
  success: { dark: "greenBright", light: "green" },
  muted: { dark: "gray", light: "gray" },
  inputGhost: { dark: "cyan", light: "blue" },
  warning: { dark: "yellowBright", light: "yellow" },
  danger: { dark: "redBright", light: "red" },
  cursor: { dark: "yellowBright", light: "yellow" },
} as const;

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

const paletteColor = (value: { dark: string; light: string }): InkColor =>
  color(value.dark, value.light);

export const terminalTheme = {
  brand: paletteColor(terminalPalette.brand),
  accent: paletteColor(terminalPalette.accent),
  focus: paletteColor(terminalPalette.focus),
  secondary: paletteColor(terminalPalette.secondary),
  citation: paletteColor(terminalPalette.citation),
  selected: paletteColor(terminalPalette.selected),
  selectedBackground: paletteColor(terminalPalette.selectedBackground),
  userName: paletteColor(terminalPalette.userName),
  aiName: paletteColor(terminalPalette.aiName),
  success: paletteColor(terminalPalette.success),
  muted: paletteColor(terminalPalette.muted),
  /** Inline ghost / autosuggest — distinct from user text and from gray-muted UI chrome */
  inputGhost: paletteColor(terminalPalette.inputGhost),
  warning: paletteColor(terminalPalette.warning),
  danger: paletteColor(terminalPalette.danger),
  cursor: paletteColor(terminalPalette.cursor),
};

export const shouldUseColor = hasColor;

export const raisedButtonStyle = {
  border: "round" as const,
  activeMarker: "●",
  inactiveMarker: "○",
};
