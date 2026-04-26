export type BillingSummaryState = {
  plan: string;
  remaining: number;
  total: number;
  status?: string;
  tone?: "normal" | "success" | "warning" | "danger" | string;
};

export const formatCredits = (value: number): string =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);

const clampRatio = (value: number): number => Math.min(1, Math.max(0, value));

export const creditProgressText = ({
  remaining,
  total,
  width = 10,
}: {
  remaining: number;
  total: number;
  width?: number;
}): string => {
  const safeWidth = Math.max(4, width);
  const ratio = total > 0 ? clampRatio(remaining / total) : 0;
  const filled = Math.round(ratio * safeWidth);
  return `[${"█".repeat(filled)}${"░".repeat(safeWidth - filled)}] ${Math.round(ratio * 100)}%`;
};

export const billingSummaryText = (
  billing: BillingSummaryState | null,
  progressWidth = 10
): string =>
  billing
    ? `Plan: ${billing.plan} | Credits: ${formatCredits(billing.remaining)}/${formatCredits(billing.total)} ${creditProgressText({
        remaining: billing.remaining,
        total: billing.total,
        width: progressWidth,
      })}`
    : "Plan: loading | Credits: loading";
