import { randomBytes, randomUUID } from "node:crypto";

export interface CLITraceContext {
  traceId: string;
  spanId: string;
  traceparent: string;
  tracestate?: string;
  requestId: string;
  correlationId: string;
}

const randomHex = (byteLength: number): string => {
  let value = "";
  do {
    value = randomBytes(byteLength).toString("hex");
  } while (/^0+$/.test(value));
  return value;
};

export const createCLITraceContext = (): CLITraceContext => {
  const traceId = randomHex(16);
  const spanId = randomHex(8);
  const requestId = randomUUID();
  return {
    traceId,
    spanId,
    traceparent: `00-${traceId}-${spanId}-01`,
    requestId,
    correlationId: requestId,
  };
};

let activeCLITraceContext: CLITraceContext | undefined;

export const setActiveCLITraceContext = (context: CLITraceContext): void => {
  activeCLITraceContext = context;
};

export const getActiveCLITraceContext = (): CLITraceContext | undefined =>
  activeCLITraceContext;

export const clearActiveCLITraceContext = (): void => {
  activeCLITraceContext = undefined;
};

export const getActiveCLITraceHeaders = (): Record<string, string> => {
  const context = getActiveCLITraceContext();
  if (!context) {
    return {};
  }
  return {
    traceparent: context.traceparent,
    ...(context.tracestate ? { tracestate: context.tracestate } : {}),
    "x-request-id": context.requestId,
    "x-correlation-id": context.correlationId,
  };
};
