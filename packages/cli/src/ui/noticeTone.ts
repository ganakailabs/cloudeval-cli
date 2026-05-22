export type NoticeTone = "success" | "warning" | "danger" | "info" | "neutral";

const matchesAny = (message: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(message));

export const classifyNoticeTone = (message: string): NoticeTone => {
  const normalized = message.trim();
  if (!normalized) {
    return "neutral";
  }

  if (
    matchesAny(normalized, [
      /^failed\b/i,
      /\bfailed:/i,
      /^error\b/i,
      /\bunavailable\b/i,
      /^cannot\b/i,
      /^could not\b/i,
      /^copy failed\b/i,
      /^no assistant response\b/i,
      /^no chat transcript\b/i,
      /^sign in before\b/i,
    ])
  ) {
    return "danger";
  }

  if (
    matchesAny(normalized, [
      /^loading\b/i,
      /^submitting\b/i,
      /\.\.\.$/,
      /^stop the running\b/i,
      /^starter selections shown\b/i,
      /^type to edit\b/i,
    ])
  ) {
    return "warning";
  }

  if (
    matchesAny(normalized, [
      /^downloaded\b/i,
      /^copied\b/i,
      /^loaded\b/i,
      /^started\b/i,
      /^project selected\b/i,
      /^model selected\b/i,
      /^profile selected\b/i,
      /^thread\b/i,
      /^report run submitted\b/i,
      /^agent profile cleared\b/i,
    ])
  ) {
    return "success";
  }

  if (
    matchesAny(normalized, [
      /^frontend link:/i,
      /^open frontend manually:/i,
      /^open session was not found\b/i,
      /^cannot resume\b/i,
      /^local threads unavailable\b/i,
      /^cloud threads unavailable\b/i,
      /queued:/i,
    ])
  ) {
    return "info";
  }

  return "neutral";
};
