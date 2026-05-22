import type { WorkspaceTab } from "./workspaceTabs.js";

export const selectableWorkspaceTab = (tab: WorkspaceTab): boolean =>
  tab === "projects" || tab === "connections";

export const nextWorkspaceSelectionIndex = ({
  currentIndex,
  itemCount,
  direction,
}: {
  currentIndex: number;
  itemCount: number;
  direction: 1 | -1;
}): number => {
  if (itemCount <= 0) {
    return 0;
  }
  const normalizedCurrent = Math.min(Math.max(0, currentIndex), itemCount - 1);
  return Math.min(Math.max(0, normalizedCurrent + direction), itemCount - 1);
};
