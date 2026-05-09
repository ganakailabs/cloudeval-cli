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
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ANIMATION_INTERVAL_MS = 80;
const BAR_WIDTH = 18;

type ReasoningStep = {
  key: string;
  message: string;
  status?: string;
};

const eventMessage = (event: Record<string, unknown>): string => {
  if (typeof event.message === "string") {
    return event.message;
  }
  if (typeof event.step === "string") {
    return event.step;
  }
  return String(event.type ?? "progress");
};

const eventStepKey = (event: Record<string, unknown>): string | undefined => {
  if (typeof event.step === "string" && event.step.trim()) {
    return event.step;
  }
  if (typeof event.node === "string" && event.node.trim()) {
    return event.node;
  }
  return undefined;
};

const eventStatus = (event: Record<string, unknown>): string | undefined =>
  typeof event.status === "string" ? event.status : undefined;

const isTerminalStatus = (status?: string): boolean =>
  status === "completed" ||
  status === "error" ||
  status === "aborted" ||
  status === "cancelled";

const renderBar = (completed: number, failed: number, total: number): string => {
  const safeTotal = Math.max(1, total);
  const completedWidth = Math.min(
    BAR_WIDTH,
    Math.round((completed / safeTotal) * BAR_WIDTH)
  );
  const failedWidth = failed ? Math.max(1, Math.min(BAR_WIDTH - completedWidth, failed)) : 0;
  const openWidth = Math.max(0, BAR_WIDTH - completedWidth - failedWidth);
  return `[${"━".repeat(completedWidth)}${"✕".repeat(failedWidth)}${"─".repeat(openWidth)}]`;
};

const truncateLine = (value: string, maxLength = 120): string => {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
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
  let spinnerIndex = 0;
  let lastLiveEvent: Record<string, unknown> | undefined;
  let animationTimer: ReturnType<typeof setInterval> | undefined;
  const reasoningSteps = new Map<string, ReasoningStep>();

  const stopAnimation = () => {
    if (!animationTimer) {
      return;
    }
    clearInterval(animationTimer);
    animationTimer = undefined;
  };

  const nextSpinner = () => {
    const frame = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length]!;
    spinnerIndex += 1;
    return frame;
  };

  const renderLiveLine = (event: Record<string, unknown>) => {
    const message = eventMessage(event);
    if (event.type === "thinking") {
      const explicitKey = eventStepKey(event);
      const key = explicitKey ?? message;
      if (explicitKey && !reasoningSteps.has(explicitKey)) {
        const previousMessageKey = Array.from(reasoningSteps.values()).find(
          (step) => step.key === step.message && step.message === message
        )?.key;
        if (previousMessageKey) {
          reasoningSteps.delete(previousMessageKey);
        }
      }
      reasoningSteps.set(key, {
        key,
        message,
        status: eventStatus(event),
      });
    }

    if (!reasoningSteps.size) {
      return `${nextSpinner()} ${truncateLine(message)}`;
    }

    const steps = Array.from(reasoningSteps.values());
    const completed = steps.filter((step) => step.status === "completed").length;
    const failed = steps.filter((step) =>
      step.status === "error" ||
      step.status === "aborted" ||
      step.status === "cancelled"
    ).length;
    const running =
      [...steps].reverse().find((step) => !isTerminalStatus(step.status)) ??
      steps[steps.length - 1];
    const currentMessage = running?.message ?? message;
    const bar = renderBar(completed, failed, steps.length);
    return `${nextSpinner()} Reasoning ${bar} ${completed}/${steps.length} | ${truncateLine(currentMessage)}`;
  };

  const redrawLiveLine = () => {
    if (!lastLiveEvent) {
      return;
    }
    stream.write(`${CLEAR_LINE}${renderLiveLine(lastLiveEvent)}`);
    liveLineActive = true;
  };

  const startAnimation = () => {
    if (!live || animationTimer) {
      return;
    }
    animationTimer = setInterval(redrawLiveLine, ANIMATION_INTERVAL_MS);
    animationTimer.unref?.();
  };

  const clear = () => {
    stopAnimation();
    lastLiveEvent = undefined;
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
        lastLiveEvent = event;
        redrawLiveLine();
        startAnimation();
        return;
      }
      stream.write(`${line}\n`);
    },
    clear,
  };
};
