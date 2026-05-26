/**
 * Some agent streams finish with status "complete" before the reducer sees the
 * final assistant message. Fall back to persisted thread history when needed.
 */
export const fetchLastAssistantContent = async ({
  baseUrl,
  authToken,
  threadId,
  normalizeApiBase,
}: {
  baseUrl: string;
  authToken: string;
  threadId: string;
  normalizeApiBase: (url: string) => string;
}): Promise<string | undefined> => {
  const response = await fetch(
    `${normalizeApiBase(baseUrl)}/chat/threads/${encodeURIComponent(threadId)}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${authToken}`,
      },
    }
  );
  if (!response.ok) {
    return undefined;
  }
  const payload = (await response.json()) as {
    messages?: Array<{ role?: string; content?: string }>;
  };
  const assistant = [...(payload.messages ?? [])]
    .reverse()
    .find((message) => message.role === "assistant");
  const content = assistant?.content?.trim();
  return content || undefined;
};
