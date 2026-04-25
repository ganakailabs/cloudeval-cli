export interface DisplayUserIdentity {
  email?: string;
  full_name?: string;
  fullName?: string;
  name?: string;
}

const toTitleCase = (value: string): string => {
  const normalized = value.trim();
  if (!normalized) {
    return "";
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
};

const firstToken = (value?: string): string | undefined => {
  const token = value?.trim().split(/\s+/)[0]?.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
  return token ? toTitleCase(token) : undefined;
};

const firstNameFromEmail = (email?: string): string | undefined => {
  const localPart = email?.split("@")[0];
  if (!localPart) {
    return undefined;
  }

  const token = localPart
    .split(/[._-]+/)
    .find((part) => /[a-z]/i.test(part))
    ?.replace(/\d+/g, "");
  return token ? toTitleCase(token) : undefined;
};

export const getFirstNameForDisplay = (
  user?: DisplayUserIdentity | null,
  fallback = "You"
): string => {
  const fromName = firstToken(user?.full_name ?? user?.fullName ?? user?.name);
  if (fromName) {
    return fromName;
  }

  return firstNameFromEmail(user?.email) ?? fallback;
};
