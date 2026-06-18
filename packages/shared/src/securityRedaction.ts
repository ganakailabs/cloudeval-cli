export const SECRET_REDACTION = "[redacted]";

const SENSITIVE_KEY_PATTERN =
  /token|authorization|cookie|secret|password|api[_-]?key|access[_-]?key|client[_-]?secret|refresh|device[_-]?code|user[_-]?code/i;

const SENSITIVE_QUERY_PARAM_PATTERN =
  /token|authorization|cookie|secret|password|api[_-]?key|access[_-]?key|client[_-]?secret|refresh|device[_-]?code|user[_-]?code|code/i;

const CLOUDEVAL_ACCESS_KEY_VALUE_PATTERN =
  /\bcev_[a-z0-9]+_ak_[A-Za-z0-9]+_[A-Za-z0-9._~+-]+(?:_[A-Za-z0-9._~+-]+)*\b/gi;

const AUTHORIZATION_BEARER_PATTERN =
  /\b(authorization\s*:\s*bearer\s+)([^\s'",}]+)/gi;

const INLINE_SECRET_ASSIGNMENT_PATTERN =
  /\b((?:token|authorization|cookie|secret|password|api[_-]?key|access[_-]?key|client[_-]?secret|refresh|device[_-]?code|user[_-]?code)=)([^&\s'",}]+)/gi;

const JSONISH_SECRET_FIELD_PATTERN =
  /(["'](?:token|authorization|cookie|secret|password|api[_-]?key|access[_-]?key|client[_-]?secret|refresh|device[_-]?code|user[_-]?code)["']\s*:\s*["'])([^"']+)(["'])/gi;

const ENCODED_SECRET_REDACTION = encodeURIComponent(SECRET_REDACTION);

export const isSensitiveSecretKey = (key: string): boolean =>
  SENSITIVE_KEY_PATTERN.test(key);

export const redactSensitiveText = (value: string): string => {
  let text = value;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return JSON.stringify(redactSensitiveSecrets(parsed));
    }
  } catch {
    // Not a JSON payload; continue with URL and token-shape redaction.
  }

  try {
    const url = new URL(text);
    let changed = false;
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAM_PATTERN.test(key)) {
        url.searchParams.set(key, SECRET_REDACTION);
        changed = true;
      }
    }
    if (changed) {
      text = url.toString();
    }
  } catch {
    // Not a standalone URL; fall through to pattern redaction.
  }

  return text
    .replace(AUTHORIZATION_BEARER_PATTERN, (_match, prefix: string) => `${prefix}${SECRET_REDACTION}`)
    .replace(JSONISH_SECRET_FIELD_PATTERN, (_match, prefix: string, _secret: string, suffix: string) => `${prefix}${SECRET_REDACTION}${suffix}`)
    .replace(INLINE_SECRET_ASSIGNMENT_PATTERN, (_match, prefix: string, secret: string) => {
      if (
        secret === SECRET_REDACTION ||
        secret.toLowerCase() === ENCODED_SECRET_REDACTION.toLowerCase()
      ) {
        return `${prefix}${secret}`;
      }
      return `${prefix}${SECRET_REDACTION}`;
    })
    .replace(CLOUDEVAL_ACCESS_KEY_VALUE_PATTERN, SECRET_REDACTION);
};

export const redactSensitiveSecrets = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveSecrets(item)) as T;
  }
  if (typeof value === "string") {
    return redactSensitiveText(value) as T;
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] =
        item === null || item === undefined
          ? item
          : isSensitiveSecretKey(key)
            ? SECRET_REDACTION
            : redactSensitiveSecrets(item);
    }
    return redacted as T;
  }
  return value;
};
