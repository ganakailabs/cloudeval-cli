export type MachineOutputFormat = "text" | "json" | "ndjson" | "markdown";

export interface SuccessEnvelope<T = unknown> {
  ok: true;
  command: string;
  data: T;
  warnings?: string[];
  frontendUrl?: string;
  filesWritten?: string[];
  traceId?: string;
}

export interface ErrorEnvelope {
  ok: false;
  command: string;
  error: {
    message: string;
    code?: string;
  };
}

export const formatSuccessEnvelope = <T>(input: {
  command: string;
  data: T;
  warnings?: string[];
  frontendUrl?: string;
  filesWritten?: string[];
  traceId?: string;
}): SuccessEnvelope<T> => {
  const envelope: SuccessEnvelope<T> = {
    ok: true,
    command: input.command,
    data: input.data,
  };
  if (input.warnings?.length) {
    envelope.warnings = input.warnings;
  }
  if (input.frontendUrl) {
    envelope.frontendUrl = input.frontendUrl;
  }
  if (input.filesWritten?.length) {
    envelope.filesWritten = input.filesWritten;
  }
  if (input.traceId) {
    envelope.traceId = input.traceId;
  }
  return envelope;
};

export const formatErrorEnvelope = (
  command: string,
  error: unknown,
  code?: string
): ErrorEnvelope => ({
  ok: false,
  command,
  error: {
    message: error instanceof Error ? error.message : String(error),
    ...(code ? { code } : {}),
  },
});

const stringifyScalar = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
};

export const formatTextRecord = (data: unknown): string => {
  if (Array.isArray(data)) {
    return data
      .map((item) =>
        typeof item === "object" && item
          ? Object.entries(item as Record<string, unknown>)
              .map(([key, value]) => `${key}: ${stringifyScalar(value)}`)
              .join("  ")
          : stringifyScalar(item)
      )
      .join("\n")
      .concat(data.length ? "\n" : "");
  }
  if (typeof data === "object" && data) {
    return Object.entries(data as Record<string, unknown>)
      .map(([key, value]) => `${key}: ${stringifyScalar(value)}`)
      .join("\n")
      .concat("\n");
  }
  return `${stringifyScalar(data)}\n`;
};

export const formatOutput = <T>(input: {
  command: string;
  data: T;
  format?: MachineOutputFormat;
  frontendUrl?: string;
  warnings?: string[];
  filesWritten?: string[];
  traceId?: string;
}): string => {
  const format = input.format ?? "text";
  if (format === "json") {
    return `${JSON.stringify(
      formatSuccessEnvelope({
        command: input.command,
        data: input.data,
        frontendUrl: input.frontendUrl,
        warnings: input.warnings,
        filesWritten: input.filesWritten,
        traceId: input.traceId,
      }),
      null,
      2
    )}\n`;
  }
  if (format === "ndjson") {
    if (Array.isArray(input.data)) {
      return input.data.map((item) => JSON.stringify(item)).join("\n") + "\n";
    }
    return `${JSON.stringify(input.data)}\n`;
  }
  if (format === "markdown") {
    return `# ${input.command}\n\n\`\`\`json\n${JSON.stringify(input.data, null, 2)}\n\`\`\`\n`;
  }
  return formatTextRecord(input.data);
};

export const writeFormattedOutput = async <T>(input: {
  command: string;
  data: T;
  format?: MachineOutputFormat;
  output?: string;
  frontendUrl?: string;
  warnings?: string[];
  filesWritten?: string[];
  traceId?: string;
}) => {
  const text = formatOutput(input);
  if (input.output) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(input.output, text, "utf8");
    return;
  }
  process.stdout.write(text);
};
