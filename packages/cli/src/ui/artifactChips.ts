import type { WorkspacePanelState } from "./workspacePanel.js";

export type ArtifactChipTone = "brand" | "normal" | "success" | "warning" | "danger";

export interface ArtifactChip {
  label: string;
  value: string;
  tone: ArtifactChipTone;
}

export interface ChatArtifactChipInput {
  projectName?: string;
  reportsStatus?: WorkspacePanelState["status"] | "idle";
  coverageLabel?: string;
  topActionCount?: number;
  frontendThreadUrl?: string;
}

export const buildChatArtifactChips = ({
  projectName,
  reportsStatus = "idle",
  coverageLabel,
  topActionCount = 0,
  frontendThreadUrl,
}: ChatArtifactChipInput): ArtifactChip[] => {
  const chips: ArtifactChip[] = [];
  if (projectName) {
    chips.push({ label: "Project", value: projectName, tone: "brand" });
  }

  if (coverageLabel) {
    chips.push({ label: "Reports", value: coverageLabel, tone: "success" });
  } else if (
    reportsStatus === "loading" ||
    reportsStatus === "ready" ||
    reportsStatus === "error"
  ) {
    chips.push({
      label: "Reports",
      value: reportsStatus,
      tone: reportsStatus === "error" ? "danger" : "normal",
    });
  }

  if (topActionCount > 0) {
    chips.push({
      label: "Actions",
      value: `${topActionCount} next`,
      tone: "warning",
    });
  }

  if (frontendThreadUrl) {
    chips.push({ label: "Web", value: "open thread", tone: "normal" });
  }

  return chips;
};
