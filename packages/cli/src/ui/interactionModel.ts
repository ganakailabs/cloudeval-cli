export type SelectorControlKind = "thread" | "project" | "model" | "mode" | "profile";
export type SelectorMouseTarget = SelectorControlKind | "thinking";
export type ChatPanelFocus = "settings" | "thread" | "prompt";
export type TuiControlFocus =
  | SelectorControlKind
  | "thinking"
  | "threadPanel"
  | `followup:${number}`;

export interface PromptTextKey {
  ctrl?: boolean;
  meta?: boolean;
  return?: boolean;
  tab?: boolean;
  escape?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

export interface SelectorControlHitArea {
  target: SelectorMouseTarget;
  startColumn: number;
  endColumn: number;
  startRow: number;
  endRow: number;
}

const selectorControls: SelectorControlKind[] = ["thread", "project", "model", "mode", "profile"];

export const buildControlFocusOrder = ({
  hasThinkingSteps,
  followUpCount,
}: {
  hasThinkingSteps: boolean;
  followUpCount: number;
}): TuiControlFocus[] => [
  ...selectorControls,
  ...(hasThinkingSteps ? (["thinking"] as const) : []),
  "threadPanel",
  ...Array.from({ length: followUpCount }, (_, index) => `followup:${index}` as const),
];

export const focusFollowUpIndex = (
  focus: TuiControlFocus
): number | undefined => {
  if (!focus.startsWith("followup:")) {
    return undefined;
  }
  const index = Number(focus.slice("followup:".length));
  return Number.isInteger(index) && index >= 0 ? index : undefined;
};

export const isSelectorControlFocus = (
  focus: TuiControlFocus
): focus is SelectorControlKind => selectorControls.includes(focus as SelectorControlKind);

export const chatPanelFocusForControl = (
  focus: TuiControlFocus
): ChatPanelFocus => {
  if (focus === "threadPanel") {
    return "thread";
  }
  if (focusFollowUpIndex(focus) !== undefined) {
    return "prompt";
  }
  return "settings";
};

export const nextControlFocus = (
  current: TuiControlFocus,
  order: TuiControlFocus[],
  direction = 1
): TuiControlFocus => {
  if (!order.length) {
    return "project";
  }

  const currentIndex = order.indexOf(current);
  if (currentIndex < 0) {
    return order[0] ?? "project";
  }

  const nextIndex = (currentIndex + direction + order.length) % order.length;
  return order[nextIndex] ?? order[0] ?? "project";
};

export const getSelectorControlHitAreas = ({
  compact,
  hasThinkingSteps,
  startColumn = 1,
  startRow,
  terminalColumns,
}: {
  compact: boolean;
  hasThinkingSteps: boolean;
  startColumn?: number;
  startRow: number;
  terminalColumns: number;
}): SelectorControlHitArea[] => {
  const safeTerminalColumns = Math.max(startColumn, terminalColumns);
  if (compact) {
    const compactRows: Array<{ target: SelectorMouseTarget; offset: number }> = [
      { target: "thread", offset: 1 },
      { target: "project", offset: 2 },
      { target: "model", offset: 4 },
      { target: "mode", offset: 5 },
      { target: "profile", offset: 6 },
      ...(hasThinkingSteps ? ([{ target: "thinking", offset: 8 }] as const) : []),
    ];
    return compactRows.map(({ target, offset }) => ({
      target,
      startColumn,
      endColumn: safeTerminalColumns,
      startRow: startRow + offset,
      endRow: startRow + offset,
    }));
  }

  const fixedAreas: SelectorControlHitArea[] = [
    {
      target: "thread",
      startColumn,
      endColumn: Math.min(safeTerminalColumns, startColumn + 27),
      startRow,
      endRow: startRow + 2,
    },
    {
      target: "project",
      startColumn: startColumn + 29,
      endColumn: Math.min(safeTerminalColumns, startColumn + 56),
      startRow,
      endRow: startRow + 2,
    },
    {
      target: "model",
      startColumn: startColumn + 58,
      endColumn: Math.min(safeTerminalColumns, startColumn + 80),
      startRow,
      endRow: startRow + 2,
    },
    {
      target: "mode",
      startColumn: startColumn + 82,
      endColumn: Math.min(safeTerminalColumns, startColumn + 100),
      startRow,
      endRow: startRow + 2,
    },
    {
      target: "profile",
      startColumn: startColumn + 102,
      endColumn: Math.min(safeTerminalColumns, startColumn + 124),
      startRow,
      endRow: startRow + 2,
    },
  ];

  if (hasThinkingSteps) {
    fixedAreas.push({
      target: "thinking",
      startColumn: startColumn + 126,
      endColumn: safeTerminalColumns,
      startRow,
      endRow: startRow + 2,
    });
  }

  return fixedAreas.filter((area) => area.startColumn <= area.endColumn);
};

export const selectorControlFromMousePosition = (
  position: { x: number; y: number },
  areas: SelectorControlHitArea[]
): SelectorMouseTarget | undefined =>
  areas.find(
    (area) =>
      position.x >= area.startColumn &&
      position.x <= area.endColumn &&
      position.y >= area.startRow &&
      position.y <= area.endRow
  )?.target;

export const isPromptTextInput = (
  input: string,
  key: PromptTextKey
): boolean => {
  if (!input || key.ctrl || key.meta) {
    return false;
  }

  if (
    key.return ||
    key.tab ||
    key.escape ||
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.pageUp ||
    key.pageDown ||
    key.backspace ||
    key.delete
  ) {
    return false;
  }

  return input.length > 0;
};
