import { randomUUID } from "node:crypto";

export const createIdempotencyKey = (): string => randomUUID();

export const withIdempotencyHeader = (
  headers: Record<string, string>,
  idempotencyKey?: string
): Record<string, string> => ({
  ...headers,
  "Idempotency-Key": idempotencyKey ?? createIdempotencyKey(),
});
