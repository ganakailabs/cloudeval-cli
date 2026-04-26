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
  promptInputRows?: number;
  promptSuggestionRows?: number;
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

export const BANNER_ART_WIDTH = 84;
export const BANNER_ART_ROWS = 6;
export const BANNER_WELCOME_ROWS = 1;
export const BANNER_VERSION_ROWS = 1;
export const BANNER_MARGIN_BOTTOM_ROWS = 1;
export const BANNER_SIDE_DETAILS_MIN_WIDTH = 42;

export const estimateBannerRows = ({
  columns,
  detailsCount = 3,
}: {
  columns: number;
  detailsCount?: number;
}): number => {
  const showArt = columns >= BANNER_ART_WIDTH;
  const detailsBesideArt =
    showArt && detailsCount > 0 && columns >= BANNER_ART_WIDTH + BANNER_SIDE_DETAILS_MIN_WIDTH;
  const detailRows = BANNER_VERSION_ROWS + detailsCount;

  if (!showArt) {
    return detailRows + BANNER_MARGIN_BOTTOM_ROWS;
  }

  if (detailsBesideArt) {
    return (
      BANNER_WELCOME_ROWS +
      Math.max(BANNER_ART_ROWS, detailRows) +
      BANNER_MARGIN_BOTTOM_ROWS
    );
  }

  return BANNER_WELCOME_ROWS + BANNER_ART_ROWS + detailRows + BANNER_MARGIN_BOTTOM_ROWS;
};

export const getResponsiveTuiLayout = (
  size: Partial<TerminalSize>,
  options: ResponsiveTuiLayoutOptions = {}
): ResponsiveTuiLayout => {
  const columns = normalizeDimension(size.columns, 100);
  const rows = normalizeDimension(size.rows, 32);
  const compact = columns < 96 || rows < 30;
  const showBanner = !options.disableBanner;

  let reservedRows =
    25 +
    Math.max(0, Math.ceil(options.promptInputRows ?? 2) - 2) +
    Math.max(0, Math.ceil(options.promptSuggestionRows ?? 0));
  if (showBanner) reservedRows += estimateBannerRows({ columns });
  if (options.hasQueue) reservedRows += 4;
  if (options.hasError) reservedRows += 4;
  if (options.hasHitl) reservedRows += 7;
  if (options.hasSelector) reservedRows += 8;
  if (options.isSearching) reservedRows += 3;

  const minThreadHeight = rows < 20 ? 3 : rows < 28 ? 4 : 6;
  const maxThreadHeight = compact ? 14 : 24;
  const availableRows = rows - reservedRows;

  return {
    compact,
    paddingX: compact ? 0 : 1,
    selectorLimit: compact ? 6 : 8,
    showBanner,
    threadHeight: clamp(availableRows, minThreadHeight, maxThreadHeight),
  };
};

export const getPromptInputRowBudget = (size: Partial<TerminalSize>): number => {
  const rows = normalizeDimension(size.rows, 32);
  if (rows < 28) {
    return 4;
  }
  if (rows < 38) {
    return 6;
  }
  return clamp(Math.floor(rows * 0.22), 8, 16);
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
