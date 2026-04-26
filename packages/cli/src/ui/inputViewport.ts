export interface InputViewportOptions {
  value: string;
  width: number;
  minRows?: number;
  maxRows?: number;
  scrollOffset?: number;
}

export interface InputViewport {
  rows: string[];
  visibleRows: string[];
  visibleRowCount: number;
  startRow: number;
  maxScrollOffset: number;
}

export const DEFAULT_INPUT_MIN_ROWS = 4;
export const DEFAULT_INPUT_MAX_ROWS = 8;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const wrapInputLine = (line: string, width: number): string[] => {
  const safeWidth = Math.max(1, width);
  if (!line) {
    return [""];
  }
  const output: string[] = [];
  for (let index = 0; index < line.length; index += safeWidth) {
    output.push(line.slice(index, index + safeWidth));
  }
  return output;
};

export const buildInputRows = (value: string, width: number): string[] =>
  value.split("\n").flatMap((line) => wrapInputLine(line, width));

export const getInputViewport = ({
  value,
  width,
  minRows = DEFAULT_INPUT_MIN_ROWS,
  maxRows = DEFAULT_INPUT_MAX_ROWS,
  scrollOffset,
}: InputViewportOptions): InputViewport => {
  const rows = buildInputRows(value, width);
  const visibleRowCount = Math.min(maxRows, Math.max(minRows, rows.length));
  const maxScrollOffset = Math.max(0, rows.length - visibleRowCount);
  const startRow = clamp(
    scrollOffset ?? maxScrollOffset,
    0,
    maxScrollOffset
  );
  const visibleRows = rows.slice(startRow, startRow + visibleRowCount);
  while (visibleRows.length < visibleRowCount) {
    visibleRows.push("");
  }

  return {
    rows,
    visibleRows,
    visibleRowCount,
    startRow,
    maxScrollOffset,
  };
};

export const nextInputScrollOffset = ({
  currentOffset,
  delta,
  maxScrollOffset,
}: {
  currentOffset: number;
  delta: number;
  maxScrollOffset: number;
}): number => clamp(currentOffset + delta, 0, maxScrollOffset);
