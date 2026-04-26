import { raisedButtonStyle } from "./theme.js";

export const workspaceTabs = [
  "chat",
  "overview",
  "reports",
  "projects",
  "connections",
  "billing",
  "options",
] as const;

export type WorkspaceTab = (typeof workspaceTabs)[number];

export const workspaceTabLabels: Record<WorkspaceTab, string> = {
  chat: "Chat",
  overview: "Overview",
  reports: "Reports",
  projects: "Projects",
  connections: "Connections",
  billing: "Billing",
  options: "Options",
};

export interface WorkspaceTabHitArea {
  tab: WorkspaceTab;
  label: string;
  startColumn: number;
  endColumn: number;
}

const tabSet = new Set<string>(workspaceTabs);

export const normalizeWorkspaceTab = (value?: string): WorkspaceTab =>
  value && tabSet.has(value.toLowerCase()) ? (value.toLowerCase() as WorkspaceTab) : "chat";

export const nextWorkspaceTab = (
  current: WorkspaceTab,
  direction: 1 | -1 = 1
): WorkspaceTab => {
  const index = workspaceTabs.indexOf(current);
  const nextIndex = (index + direction + workspaceTabs.length) % workspaceTabs.length;
  return workspaceTabs[nextIndex];
};

export const workspaceTabFromShortcut = (value: string): WorkspaceTab | undefined => {
  const index = Number(value) - 1;
  return Number.isInteger(index) && index >= 0 && index < workspaceTabs.length
    ? workspaceTabs[index]
    : undefined;
};

export const workspaceTabFromPromptChange = (
  previousValue: string,
  nextValue: string
): WorkspaceTab | undefined => {
  if (previousValue.trim()) {
    return undefined;
  }
  return nextValue.length === 1 ? workspaceTabFromShortcut(nextValue) : undefined;
};

export const workspaceTabButtonLabel = (tab: WorkspaceTab): string =>
  `${workspaceTabs.indexOf(tab) + 1} ${workspaceTabLabels[tab]}`;

export const workspaceTabButtonContent = (tab: WorkspaceTab, active = false): string =>
  `${active ? raisedButtonStyle.activeMarker : raisedButtonStyle.inactiveMarker} ${workspaceTabButtonLabel(tab)}`;

export const getWorkspaceTabHitAreas = ({
  startColumn = 1,
  gap = 1,
}: {
  startColumn?: number;
  gap?: number;
} = {}): WorkspaceTabHitArea[] => {
  let cursor = startColumn;
  return workspaceTabs.map((tab) => {
    const label = workspaceTabButtonLabel(tab);
    const width = label.length + 6;
    const area = {
      tab,
      label,
      startColumn: cursor,
      endColumn: cursor + width - 1,
    };
    cursor = area.endColumn + 1 + gap;
    return area;
  });
};

export const workspaceTabFromColumn = (
  column: number,
  areas: WorkspaceTabHitArea[]
): WorkspaceTab | undefined =>
  areas.find((area) => column >= area.startColumn && column <= area.endColumn)?.tab;
