export type SelectorControlKind = "project" | "model" | "mode";
export type SelectorMouseTarget = SelectorControlKind | "thinking";
export type TuiControlFocus =
  | SelectorControlKind
  | "thinking"
  | `followup:${number}`;

export interface SelectorControlHitArea {
  target: SelectorMouseTarget;
  startColumn: number;
  endColumn: number;
  startRow: number;
  endRow: number;
}

const selectorControls: SelectorControlKind[] = ["project", "model", "mode"];

export const buildControlFocusOrder = ({
  hasThinkingSteps,
  followUpCount,
}: {
  hasThinkingSteps: boolean;
  followUpCount: number;
}): TuiControlFocus[] => [
  ...selectorControls,
  ...(hasThinkingSteps ? (["thinking"] as const) : []),
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
    const targets: SelectorMouseTarget[] = [
      ...selectorControls,
      ...(hasThinkingSteps ? (["thinking"] as const) : []),
    ];
    return targets.map((target, index) => ({
      target,
      startColumn,
      endColumn: safeTerminalColumns,
      startRow: startRow + index * 3,
      endRow: startRow + index * 3 + 2,
    }));
  }

  const fixedAreas: SelectorControlHitArea[] = [
    {
      target: "project",
      startColumn,
      endColumn: Math.min(safeTerminalColumns, startColumn + 27),
      startRow,
      endRow: startRow + 2,
    },
    {
      target: "model",
      startColumn: startColumn + 29,
      endColumn: Math.min(safeTerminalColumns, startColumn + 51),
      startRow,
      endRow: startRow + 2,
    },
    {
      target: "mode",
      startColumn: startColumn + 53,
      endColumn: Math.min(safeTerminalColumns, startColumn + 71),
      startRow,
      endRow: startRow + 2,
    },
  ];

  if (hasThinkingSteps) {
    fixedAreas.push({
      target: "thinking",
      startColumn: startColumn + 73,
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
