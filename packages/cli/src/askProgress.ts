export const ASK_PROGRESS_MODES = new Set(["auto", "stderr", "ndjson", "none"]);

export type AskProgressMode = "auto" | "stderr" | "ndjson" | "none";

export type AskProgressWriterOptions = {
  mode: AskProgressMode;
  format: string;
  quiet?: boolean;
  output?: string;
  stream?: NodeJS.WritableStream & { isTTY?: boolean };
  dataStream?: NodeJS.WritableStream;
  live?: boolean;
};

export type AskProgressWriter = {
  write(event: Record<string, unknown>): void;
  clear(): void;
};

const CLEAR_LINE = "\r\u001B[2K";

const eventMessage = (event: Record<string, unknown>): string => {
  if (typeof event.message === "string") {
    return event.message;
  }
  if (typeof event.step === "string") {
    return event.step;
  }
  return String(event.type ?? "progress");
};

export const normalizeAskProgressMode = (value?: string): AskProgressMode => {
  const normalized = (value ?? "auto").toLowerCase();
  if (ASK_PROGRESS_MODES.has(normalized)) {
    return normalized as AskProgressMode;
  }
  throw new Error("--progress must be one of: auto, stderr, ndjson, none");
};

export const createAskProgressWriter = (
  options: AskProgressWriterOptions
): AskProgressWriter => {
  const stream = options.stream ?? process.stderr;
  const dataStream = options.dataStream ?? process.stdout;
  const resolvedMode =
    options.mode === "auto"
      ? options.format === "ndjson" && !options.output
        ? "ndjson"
        : "stderr"
      : options.mode;
  const live =
    Boolean(options.live) &&
    resolvedMode === "stderr" &&
    Boolean(stream.isTTY);
  let liveLineActive = false;

  const clear = () => {
    if (!liveLineActive) {
      return;
    }
    stream.write(CLEAR_LINE);
    liveLineActive = false;
  };

  return {
    write(event) {
      if (options.quiet || resolvedMode === "none") {
        return;
      }

      if (resolvedMode === "ndjson" && options.format === "ndjson" && !options.output) {
        dataStream.write(`${JSON.stringify(event)}\n`);
        return;
      }

      const line = `[${event.type ?? "progress"}] ${eventMessage(event)}`;
      if (live) {
        stream.write(`${CLEAR_LINE}${line}`);
        liveLineActive = true;
        return;
      }
      stream.write(`${line}\n`);
    },
    clear,
  };
};
