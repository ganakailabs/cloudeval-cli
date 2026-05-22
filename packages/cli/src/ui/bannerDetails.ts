import type { BillingSummaryState } from "./billingSummary.js";
import { truncateForTerminal } from "./layout.js";
import { terminalTheme } from "./theme.js";

export type BannerDetailSegment = {
  text: string;
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
};

export type BannerDetailLine = {
  key: string;
  segments: BannerDetailSegment[];
};

const labelSegment = (label: string): BannerDetailSegment => ({
  text: label,
  dimColor: true,
});

const valueSegment = (value: string, color?: string): BannerDetailSegment => ({
  text: value,
  color,
});

const creditToneColor = (tone?: BillingSummaryState["tone"]): string | undefined => {
  if (tone === "warning" || tone === "low") {
    return terminalTheme.warning;
  }
  if (tone === "exhausted" || tone === "danger") {
    return terminalTheme.danger;
  }
  if (tone === "success" || tone === "normal") {
    return terminalTheme.success;
  }
  return terminalTheme.brand;
};

export const buildBannerDetailLines = ({
  apiBase,
  frontendBaseUrl,
  billingSummary,
  billingTone,
  userName,
  userEmail,
}: {
  apiBase: string;
  frontendBaseUrl: string;
  billingSummary: string;
  billingTone?: BillingSummaryState["tone"];
  userName: string;
  userEmail?: string;
}): BannerDetailLine[] => {
  const displayName = truncateForTerminal(userName.trim() || "You", 48);
  const email = userEmail?.trim();
  const userSegments: BannerDetailSegment[] = [
    labelSegment("User: "),
    valueSegment(displayName, terminalTheme.userName),
  ];
  if (email) {
    userSegments.push({
      text: ` (${truncateForTerminal(email, 56)})`,
      dimColor: true,
    });
  }

  const billingUnavailable = billingSummary.includes("unavailable");

  return [
    { key: "user", segments: userSegments },
    {
      key: "api",
      segments: [
        labelSegment("API: "),
        valueSegment(truncateForTerminal(apiBase, 72), terminalTheme.secondary),
      ],
    },
    {
      key: "frontend",
      segments: [
        labelSegment("Frontend: "),
        valueSegment(truncateForTerminal(frontendBaseUrl, 72), terminalTheme.secondary),
      ],
    },
    {
      key: "billing",
      segments: [
        {
          text: billingSummary,
          color: billingUnavailable ? terminalTheme.warning : creditToneColor(billingTone),
          bold: !billingUnavailable,
        },
      ],
    },
  ];
};

/** @deprecated Use buildBannerDetailLines for colored banner metadata. */
export const buildTuiHeaderDetails = (options: {
  apiBase: string;
  frontendBaseUrl: string;
  billingSummary: string;
  userName: string;
  userEmail?: string;
}): string[] =>
  buildBannerDetailLines(options).map((line) =>
    line.segments.map((segment) => segment.text).join("")
  );
