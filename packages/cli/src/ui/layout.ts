export interface TerminalSize {
  columns: number;
  rows: number;
}

export interface ResponsiveTuiLayoutOptions {
  disableBanner?: boolean;
  hasQueue?: boolean;
  hasError?: boolean;
  hasHitl?: boolean;
  hasSelector?: boolean;
  isSearching?: boolean;
}

export interface ResponsiveTuiLayout {
  compact: boolean;
  paddingX: number;
  selectorLimit: number;
  showBanner: boolean;
  threadHeight: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const normalizeDimension = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && value && value > 0 ? value : fallback;

export const getResponsiveTuiLayout = (
  size: Partial<TerminalSize>,
  options: ResponsiveTuiLayoutOptions = {}
): ResponsiveTuiLayout => {
  const columns = normalizeDimension(size.columns, 100);
  const rows = normalizeDimension(size.rows, 32);
  const compact = columns < 96 || rows < 30;
  const hasDemandingPanel =
    Boolean(options.hasQueue) ||
    Boolean(options.hasError) ||
    Boolean(options.hasHitl) ||
    Boolean(options.hasSelector);
  const showBanner =
    !options.disableBanner &&
    !options.isSearching &&
    columns >= 80 &&
    rows >= 24 &&
    !(compact && hasDemandingPanel);

  let reservedRows = 10;
  if (showBanner) reservedRows += 8;
  if (options.hasQueue) reservedRows += 4;
  if (options.hasError) reservedRows += 4;
  if (options.hasHitl) reservedRows += 7;
  if (options.hasSelector) reservedRows += 8;
  if (options.isSearching) reservedRows += 3;

  const minThreadHeight = rows < 20 ? 4 : rows < 28 ? 6 : 8;
  const maxThreadHeight = compact ? 16 : 28;
  const availableRows = rows - reservedRows;

  return {
    compact,
    paddingX: compact ? 0 : 1,
    selectorLimit: compact ? 6 : 8,
    showBanner,
    threadHeight: clamp(availableRows, minThreadHeight, maxThreadHeight),
  };
};

export const truncateForTerminal = (value: string, maxLength: number): string => {
  if (maxLength <= 0) {
    return "";
  }
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 3) {
    return ".".repeat(maxLength);
  }
  return `${value.slice(0, maxLength - 3)}...`;
};
