export type TuiKeyBindings = {
  submit: string;
  newline: string;
  quit: string;
  tabFocus: string;
  tabSwitch: string;
  commandComplete: string;
  historySearch: string;
  cancel: string;
  scroll: string;
  mouse: string;
  open: string;
  refresh: string;
};

export const getTuiKeyBindings = (
  platform: NodeJS.Platform = process.platform
): TuiKeyBindings => ({
  submit: "Enter send",
  newline:
    platform === "darwin"
      ? "Option+Enter or Ctrl+J newline"
      : "Alt+Enter or Ctrl+J newline",
  quit: "Ctrl+C quit",
  tabFocus: "Tab focus",
  tabSwitch: "Arrow keys move focus",
  commandComplete: "Tab/↑↓ slash command menu",
  historySearch: "Ctrl+R history search",
  cancel: "Esc cancel response",
  scroll: "Ctrl+Up/Down scroll",
  mouse: "Mouse clicks tabs, settings, prompts",
  open: "O open frontend",
  refresh: "R refresh tab",
});

export const getChatInputHelpText = ({
  isCancelling,
  inputActive = true,
  promptCount = 0,
}: {
  isCancelling: boolean;
  inputActive?: boolean;
  promptCount?: number;
}): string => {
  if (isCancelling) {
    return "Esc stop | Ctrl+C quit | /stop | /help";
  }

  if (!inputActive) {
    return "Type to edit | Tab/Arrows controls | 1-8 tabs | /help";
  }

  if (promptCount <= 0) {
    return "Enter send | Esc controls | /copy | /download | /help";
  }

  return "Enter send/choose | Esc controls | /copy | Tab focus | /help";
};
