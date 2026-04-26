export const CLOUD_BASE_URL = "https://cloudeval.ai/api/v1";

export const getDefaultBaseUrl = (env: NodeJS.ProcessEnv = process.env): string => {
  const configured = env.CLOUDEVAL_BASE_URL?.trim();
  return configured || CLOUD_BASE_URL;
};

export const isLocalBaseUrl = (baseUrl?: string): boolean => {
  if (!baseUrl) {
    return false;
  }

  try {
    const { hostname } = new URL(baseUrl);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
};

export const shouldUseStoredBaseUrl = (
  storedBaseUrl?: string,
  env: NodeJS.ProcessEnv = process.env
): boolean => {
  if (!storedBaseUrl) {
    return false;
  }
  if (env.CLOUDEVAL_ALLOW_STORED_LOCAL_BASE_URL === "1") {
    return true;
  }
  return !isLocalBaseUrl(storedBaseUrl);
};
