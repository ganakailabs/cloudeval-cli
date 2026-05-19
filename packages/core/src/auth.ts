import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { redactSensitiveText } from "@cloudeval/shared";

const DEFAULT_BASE_URL = "https://cloudeval.ai/api/proxy/v1";
const DEFAULT_FRONTEND_URL = "https://cloudeval.ai";
const TOKEN_EXPIRY_SKEW_MS = 120_000;
const ACCESS_SECRET_LABEL = "access-token";
const REFRESH_SECRET_LABEL = "refresh-token";
const INSECURE_FILE_FALLBACK_ENV = "CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE";
const CONCURRENT_REFRESH_WAIT_STEPS_MS = [50, 100, 150, 250];
const REFRESH_LOCK_WAIT_STEP_MS = 100;
const REFRESH_LOCK_STALE_MS = 30_000;
const CLI_DEBUG_ENV = "CLOUDEVAL_CLI_DEBUG";
const SENSITIVE_DEBUG_KEY_PATTERN =
  /token|authorization|cookie|secret|password|api[_-]?key|access[_-]?key|client_secret|refresh|device[_-]?code|user[_-]?code/i;
const SENSITIVE_DEBUG_QUERY_PARAM_PATTERN =
  /token|authorization|cookie|secret|password|api[_-]?key|access[_-]?key|client_secret|refresh|device[_-]?code|user[_-]?code|code/i;

const KEYCHAIN_SERVICE = "cloudeval-cli";
const KEYCHAIN_LABEL = "Cloudeval CLI";

const isCliDebugEnabled = () => {
  const value = process.env[CLI_DEBUG_ENV];
  return value === "1" || value?.toLowerCase() === "true";
};

const redactDebugValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => redactDebugValue(item));
  }
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      let changed = false;
      for (const key of Array.from(url.searchParams.keys())) {
        if (SENSITIVE_DEBUG_QUERY_PARAM_PATTERN.test(key)) {
          url.searchParams.set(key, "[REDACTED]");
          changed = true;
        }
      }
      return redactSensitiveText(changed ? url.toString() : value);
    } catch {
      return redactSensitiveText(value);
    }
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] = SENSITIVE_DEBUG_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : redactDebugValue(item);
    }
    return redacted;
  }
  return value;
};

const cliDebug = (message: string, data?: Record<string, unknown>) => {
  if (!isCliDebugEnabled()) {
    return;
  }
  const prefix = `[${new Date().toISOString()}] [CLI DEBUG]`;
  if (data === undefined) {
    console.error(`${prefix} ${message}`);
    return;
  }
  try {
    console.error(
      `${prefix} ${message}\n${JSON.stringify(redactDebugValue(data), null, 2)}`
    );
  } catch {
    console.error(`${prefix} ${message}`, redactDebugValue(data));
  }
};

interface AuthOptions {
  accessKey?: string;
  baseUrl?: string;
  forceRefresh?: boolean;
}

interface LogoutOptions {
  baseUrl?: string;
  allDevices?: boolean;
}

interface LoginOptions {
  headless?: boolean;
  browserOpener?: (url: string) => boolean;
}

interface StoredAuth {
  token?: string;
  tokenRef?: string;
  tokenExpiresAt?: number;
  refreshToken?: string;
  refreshTokenRef?: string;
  sessionId?: string;
  accountId?: string;
  baseUrl?: string;
  lastRefreshAt?: number;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  session_id?: string;
  account_id?: string;
}

interface DeviceTokenResponse extends TokenResponse {
  status?: string;
  interval?: number;
  error?: string;
  onboarding_required?: boolean;
}

interface DeviceCodeLoginOptions {
  openInBrowser?: boolean;
  browserOpener?: (url: string) => boolean;
}

interface UserStatus {
  exists: boolean;
  onboardingCompleted: boolean;
  user?: {
    id: string;
    email: string;
    full_name?: string;
    name?: string;
    preferences?: {
      onboarding?: {
        completedAt?: number;
      };
    };
  };
}

interface AuthStatus {
  authenticated: boolean;
  accessTokenCached: boolean;
  accessTokenExpiresAt?: number;
  hasRefreshToken: boolean;
  sessionId?: string;
  accountId?: string;
  baseUrl?: string;
  storageBackend: SecretBackend;
  validationAttempted?: boolean;
  authError?: string;
}

interface AuthStatusOptions {
  validate?: boolean;
}

type SecretBackend =
  | "macos-keychain"
  | "linux-libsecret"
  | "windows-dpapi"
  | "insecure-file"
  | "memory";

let cachedToken: { token: string; expiresAt: number } | null = null;
let stored: StoredAuth | null = null;
let refreshInFlight: Promise<string> | null = null;
let warnedAboutSecretBackend = false;
const memorySecrets = new Map<string, string>();

const now = () => Date.now();
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const errorMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : String(error ?? "Unknown error");

const isRejectedRefreshTokenError = (error: unknown): boolean => {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("invalid_grant") ||
    message.includes("consent_required") ||
    message.includes("aadsts65001") ||
    message.includes("interaction_required") ||
    (message.includes("refresh token") &&
      (message.includes("revoked") ||
        message.includes("expired") ||
        message.includes("invalid"))) ||
    message.includes("aadsts700082") ||
    message.includes("aadsts70000")
  );
};

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
};

const configDir = path.join(os.homedir(), ".config", "cloudeval");
const configPath = path.join(configDir, "config.json");
const secretFilePath = path.join(configDir, "secrets.json");
const refreshLockPath = path.join(configDir, "refresh.lock");

const commandExists = (cmd: string): boolean => {
  const whichCmd = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(whichCmd, [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const detectSecretBackend = (): SecretBackend => {
  if (process.env[INSECURE_FILE_FALLBACK_ENV] === "1") {
    return "insecure-file";
  }
  if (process.platform === "darwin" && commandExists("security")) {
    return "macos-keychain";
  }
  if (process.platform === "linux" && commandExists("secret-tool")) {
    return "linux-libsecret";
  }
  if (process.platform === "win32" && commandExists("powershell")) {
    return "windows-dpapi";
  }
  return "memory";
};

const ensureConfigDir = () => {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
};

const acquireRefreshLock = async (): Promise<() => void> => {
  ensureConfigDir();

  while (true) {
    try {
      const fd = fs.openSync(refreshLockPath, "wx", 0o600);
      let released = false;

      try {
        fs.writeFileSync(fd, String(process.pid), { encoding: "utf8" });
      } catch {
        // Best-effort metadata only; lock ownership is the file itself.
      }

      return () => {
        if (released) {
          return;
        }
        released = true;

        try {
          fs.closeSync(fd);
        } catch {
          // no-op
        }

        try {
          fs.unlinkSync(refreshLockPath);
        } catch {
          // no-op
        }
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      try {
        const pid = Number(fs.readFileSync(refreshLockPath, "utf8").trim());
        if (pid && !isProcessAlive(pid)) {
          fs.unlinkSync(refreshLockPath);
          continue;
        }
      } catch {
        // Fall through to mtime-based stale lock handling.
      }

      try {
        const stat = fs.statSync(refreshLockPath);
        if (now() - stat.mtimeMs > REFRESH_LOCK_STALE_MS) {
          fs.unlinkSync(refreshLockPath);
          continue;
        }
      } catch {
        continue;
      }

      await sleep(REFRESH_LOCK_WAIT_STEP_MS);
    }
  }
};

const readSecretsFile = (): Record<string, string> => {
  try {
    const raw = fs.readFileSync(secretFilePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeSecretsFile = (secrets: Record<string, string>) => {
  ensureConfigDir();
  fs.writeFileSync(secretFilePath, JSON.stringify(secrets, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(secretFilePath, 0o600);
  } catch {
    // no-op
  }
};

const dpapiProtect = (plainText: string): string => {
  const script =
    "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:CLOUDEVAL_SECRET), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))";
  return execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDEVAL_SECRET: plainText,
      },
    }
  ).trim();
};

const dpapiUnprotect = (cipherTextB64: string): string => {
  const script =
    "$bytes=[System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:CLOUDEVAL_SECRET_B64), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($bytes)";
  return execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDEVAL_SECRET_B64: cipherTextB64,
      },
    }
  ).trim();
};

const setSecret = (key: string, value: string): boolean => {
  const backend = detectSecretBackend();
  try {
    if (backend === "macos-keychain") {
      execFileSync("security", [
        "add-generic-password",
        "-a",
        key,
        "-s",
        KEYCHAIN_SERVICE,
        "-l",
        KEYCHAIN_LABEL,
        "-w",
        value,
        "-U",
      ]);
      return true;
    }

    if (backend === "linux-libsecret") {
      const result = spawnSync(
        "secret-tool",
        [
          "store",
          "--label",
          KEYCHAIN_LABEL,
          "service",
          KEYCHAIN_SERVICE,
          "account",
          key,
        ],
        {
          input: value,
          encoding: "utf8",
        }
      );
      return result.status === 0;
    }

    if (backend === "windows-dpapi") {
      const encrypted = dpapiProtect(value);
      const secrets = readSecretsFile();
      secrets[key] = encrypted;
      writeSecretsFile(secrets);
      return true;
    }

    if (backend === "insecure-file") {
      const secrets = readSecretsFile();
      secrets[key] = value;
      writeSecretsFile(secrets);
      return true;
    }

    memorySecrets.set(key, value);
    return false;
  } catch {
    memorySecrets.set(key, value);
    return false;
  }
};

const getSecret = (key: string): string | undefined => {
  const backend = detectSecretBackend();
  try {
    if (backend === "macos-keychain") {
      return execFileSync("security", [
        "find-generic-password",
        "-a",
        key,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ], { encoding: "utf8" }).trim();
    }

    if (backend === "linux-libsecret") {
      return execFileSync(
        "secret-tool",
        ["lookup", "service", KEYCHAIN_SERVICE, "account", key],
        { encoding: "utf8" }
      ).trim();
    }

    if (backend === "windows-dpapi") {
      const secrets = readSecretsFile();
      const encrypted = secrets[key];
      if (!encrypted) {
        return undefined;
      }
      return dpapiUnprotect(encrypted);
    }

    if (backend === "insecure-file") {
      const secrets = readSecretsFile();
      return secrets[key];
    }

    return memorySecrets.get(key);
  } catch {
    return memorySecrets.get(key);
  }
};

const deleteSecret = (key: string) => {
  const backend = detectSecretBackend();
  try {
    if (backend === "macos-keychain") {
      execFileSync(
        "security",
        [
          "delete-generic-password",
          "-a",
          key,
          "-s",
          KEYCHAIN_SERVICE,
        ],
        { stdio: "ignore" }
      );
    } else if (backend === "linux-libsecret") {
      execFileSync(
        "secret-tool",
        [
          "clear",
          "service",
          KEYCHAIN_SERVICE,
          "account",
          key,
        ],
        { stdio: "ignore" }
      );
    } else if (backend === "windows-dpapi" || backend === "insecure-file") {
      const secrets = readSecretsFile();
      if (secrets[key]) {
        delete secrets[key];
        writeSecretsFile(secrets);
      }
    }
  } catch {
    // no-op
  }
  memorySecrets.delete(key);
};

const warnOnInsecureSecretStorage = () => {
  if (warnedAboutSecretBackend) {
    return;
  }
  warnedAboutSecretBackend = true;
  const backend = detectSecretBackend();
  if (backend === "memory") {
    console.warn(
      "Secure credential storage is unavailable on this system. Session refresh tokens will not persist across CLI restarts."
    );
    console.warn(
      `To force file fallback (less secure), set ${INSECURE_FILE_FALLBACK_ENV}=1.`
    );
  } else if (backend === "insecure-file") {
    console.warn(
      `Using insecure file secret fallback because ${INSECURE_FILE_FALLBACK_ENV}=1 is set.`
    );
  }
};

const isLocalHostname = (hostname: string): boolean => {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "::1" ||
    lower === "[::1]"
  );
};

export const assertSecureBaseUrl = (rawBaseUrl: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new Error(`Invalid base URL: ${rawBaseUrl}`);
  }

  if (parsed.protocol === "https:") {
    return;
  }

  if (parsed.protocol === "http:" && isLocalHostname(parsed.hostname)) {
    return;
  }

  throw new Error(
    `Refusing insecure base URL (${rawBaseUrl}). Use HTTPS for non-localhost endpoints.`
  );
};

export const normalizeApiBase = (baseUrl?: string): string => {
  const raw = baseUrl || process.env.CLOUDEVAL_BASE_URL || DEFAULT_BASE_URL;
  assertSecureBaseUrl(raw);
  const trimmed = raw.replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (hostname === "cloudeval.ai" && ["/", "/api", "/api/v1"].includes(path)) {
      url.pathname = "/api/proxy/v1";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    // assertSecureBaseUrl already validates this path; keep the legacy fallback below.
  }
  if (trimmed.endsWith("/api/v1") || trimmed.endsWith("/api/proxy/v1")) {
    return trimmed;
  }
  if (trimmed.endsWith("/api/proxy")) {
    return `${trimmed}/v1`;
  }
  return trimmed.replace(/\/api\/?$/, "") + "/api/v1";
};

const resolveAuthBootstrapBase = (apiBase: string): string => {
  try {
    const url = new URL(apiBase);
    const path = url.pathname.replace(/\/+$/, "");
    if (
      url.hostname.toLowerCase() === "cloudeval.ai" &&
      /\/api\/proxy\/v1$/i.test(path)
    ) {
      url.pathname = path.replace(/\/api\/proxy\/v1$/i, "/api/v1");
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    // normalizeApiBase already validates this path; keep the original base.
  }

  return apiBase;
};

const sanitizeStoredForDisk = (data: StoredAuth): StoredAuth => {
  const clone: StoredAuth = { ...data };
  delete clone.token;
  delete clone.refreshToken;
  return clone;
};

const migrateLegacySecrets = (parsed: StoredAuth): StoredAuth => {
  const migrated: StoredAuth = { ...parsed };

  if (parsed.token && !parsed.tokenRef) {
    const ref = ACCESS_SECRET_LABEL;
    const persisted = setSecret(ref, parsed.token);
    if (!persisted) {
      warnOnInsecureSecretStorage();
    }
    migrated.tokenRef = ref;
    delete migrated.token;
  }

  if (parsed.refreshToken && !parsed.refreshTokenRef) {
    const ref = REFRESH_SECRET_LABEL;
    const persisted = setSecret(ref, parsed.refreshToken);
    if (!persisted) {
      warnOnInsecureSecretStorage();
    }
    migrated.refreshTokenRef = ref;
    delete migrated.refreshToken;
  }

  return migrated;
};

const loadStoredFromDisk = (): StoredAuth => {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as StoredAuth;
    const nextStored = migrateLegacySecrets(parsed);

    const accessToken = getAccessToken(nextStored);
    if (accessToken) {
      cachedToken = {
        token: accessToken,
        expiresAt: nextStored.tokenExpiresAt ?? 0,
      };
    }

    if (nextStored !== parsed) {
      const sanitized = sanitizeStoredForDisk(nextStored);
      fs.writeFileSync(configPath, JSON.stringify(sanitized, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
    }

    return nextStored;
  } catch {
    return {};
  }
};

const readStored = (): StoredAuth => {
  if (stored) {
    return stored;
  }

  stored = loadStoredFromDisk();
  return stored;
};

const reloadStored = (): StoredAuth => {
  stored = loadStoredFromDisk();
  return stored;
};

const writeStored = (data: StoredAuth) => {
  const sanitized = sanitizeStoredForDisk(data);
  try {
    ensureConfigDir();
    fs.writeFileSync(configPath, JSON.stringify(sanitized, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      fs.chmodSync(configPath, 0o600);
    } catch {
      // no-op
    }
    stored = sanitized;
  } catch {
    stored = sanitized;
  }
};

const getRefreshToken = (data: StoredAuth): string | undefined => {
  if (data.refreshTokenRef) {
    return getSecret(data.refreshTokenRef);
  }
  return undefined;
};

const getAccessToken = (data: StoredAuth): string | undefined => {
  if (data.tokenRef) {
    return getSecret(data.tokenRef);
  }
  return data.token;
};

const saveAccessToken = (data: StoredAuth, accessToken?: string): StoredAuth => {
  const next = { ...data };

  if (!accessToken) {
    return next;
  }

  const ref = next.tokenRef || ACCESS_SECRET_LABEL;
  const persisted = setSecret(ref, accessToken);
  if (!persisted) {
    warnOnInsecureSecretStorage();
  }
  next.tokenRef = ref;
  return next;
};

const saveRefreshToken = (data: StoredAuth, refreshToken?: string): StoredAuth => {
  const next = { ...data };

  if (!refreshToken) {
    return next;
  }

  const ref = next.refreshTokenRef || REFRESH_SECRET_LABEL;
  const persisted = setSecret(ref, refreshToken);
  if (!persisted) {
    warnOnInsecureSecretStorage();
  }
  next.refreshTokenRef = ref;
  return next;
};

const clearLocalAuth = (data?: StoredAuth) => {
  cachedToken = null;
  refreshInFlight = null;

  const current = data ?? readStored();
  if (current.tokenRef) {
    deleteSecret(current.tokenRef);
  }
  if (current.refreshTokenRef) {
    deleteSecret(current.refreshTokenRef);
  }

  stored = {};
  writeStored({});

  try {
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
  } catch {
    // no-op
  }
};

export const clearAuthSession = (): void => {
  clearLocalAuth();
};

const setCachedToken = (token: string, expiresInSeconds: number) => {
  cachedToken = {
    token,
    expiresAt: now() + expiresInSeconds * 1000 - TOKEN_EXPIRY_SKEW_MS,
  };
};

const persistAuthTokens = (
  tokenResponse: TokenResponse,
  context: { baseUrl: string }
): string => {
  setCachedToken(tokenResponse.access_token, tokenResponse.expires_in ?? 3600);
  const current = readStored();

  let next: StoredAuth = {
    ...current,
    token: tokenResponse.access_token,
    tokenExpiresAt: cachedToken?.expiresAt,
    sessionId: tokenResponse.session_id ?? current.sessionId,
    accountId: tokenResponse.account_id ?? current.accountId,
    baseUrl: context.baseUrl,
    lastRefreshAt: now(),
  };

  next = saveAccessToken(next, tokenResponse.access_token);
  next = saveRefreshToken(next, tokenResponse.refresh_token);
  writeStored(next);

  return tokenResponse.access_token;
};

const getCLIClientId = () => process.env.CLOUDEVAL_CLI_CLIENT_ID ?? "cloudeval-cli";

const getDeviceVerificationOverride = () =>
  (
    process.env.CLOUDEVAL_DEVICE_VERIFICATION_URI ||
    process.env.CLOUDEVAL_FRONTEND_URL ||
    process.env.CLOUDEVAL_WEB_URL ||
    ""
  ).trim();

const DEVICE_LOGIN_PROMPT = "select_account";

const forceDeviceLoginAccountChooser = (value: string): string => {
  const url = new URL(value);
  url.searchParams.set("prompt", DEVICE_LOGIN_PROMPT);
  return url.toString();
};

const buildDeviceVerificationUrl = (override: string, userCode?: string): string => {
  const url = new URL(override);
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/device/login";
  }
  if (userCode) {
    url.searchParams.set("user_code", userCode);
  }
  url.searchParams.set("prompt", DEVICE_LOGIN_PROMPT);
  return url.toString();
};

const isLocalDeviceVerificationUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
};

const resolveDeviceVerificationUrl = (deviceCodeData: DeviceCodeResponse): string => {
  const override = getDeviceVerificationOverride();
  if (override) {
    try {
      return buildDeviceVerificationUrl(override, deviceCodeData.user_code);
    } catch {
      console.warn(
        `Ignoring invalid device verification URL override: ${override}`
      );
    }
  }
  const backendUrl =
    deviceCodeData.verification_uri_complete ||
    (() => {
      try {
        return buildDeviceVerificationUrl(
          deviceCodeData.verification_uri,
          deviceCodeData.user_code
        );
      } catch {
        return deviceCodeData.verification_uri;
      }
    })();
  if (isLocalDeviceVerificationUrl(backendUrl)) {
    return buildDeviceVerificationUrl(DEFAULT_FRONTEND_URL, deviceCodeData.user_code);
  }
  try {
    return forceDeviceLoginAccountChooser(backendUrl);
  } catch {
    return backendUrl;
  }
};

const openBrowser = (url: string): boolean => {
  try {
    if (process.platform === "darwin") {
      const child = spawn("open", [url], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return true;
    }

    if (process.platform === "win32") {
      const child = spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return true;
    }

    if (commandExists("xdg-open")) {
      const child = spawn("xdg-open", [url], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return true;
    }

    return false;
  } catch {
    return false;
  }
};

// Project interface matching frontend
export interface Project {
  id: string;
  name: string;
  user_id?: string;
  description?: string;
  cloud_provider?: string;
  type?: "template" | "sync";
  connection_ids?: string[];
  created_at?: string;
  updated_at?: string;
}

interface PlaygroundUser {
  id: string;
  email?: string;
  fullName?: string;
  full_name?: string;
  name?: string;
}

interface QuickOnboardResponse {
  user?: {
    id?: string;
    email?: string;
    preferences?: {
      onboarding?: {
        completedAt?: string | number;
      };
    };
  };
  playground_project?: Project;
  default_connection?: {
    id?: string;
    name?: string;
  };
  onboarding_completed_at?: string;
  setup_jobs?: Array<{
    operation?: string;
    status?: string;
    job_id?: string;
  }>;
}

const PLAYGROUND_PROJECT_NAME = "Playground";

// Helper to get CLI client headers
export const getCLIHeaders = (token?: string): Record<string, string> => {
  const headers: Record<string, string> = {
    "X-Client-Type": "cloudeval-cli",
    "X-Client-Version": "0.1.0",
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
};

// Fetch projects for a user (matches frontend: GET /projects/user/{userId})
export const getProjects = async (
  baseUrl: string,
  token: string,
  userId: string
): Promise<Project[]> => {
  try {
    const apiBase = normalizeApiBase(baseUrl);
    cliDebug("getProjects request", {
      url: `${apiBase}/projects/user/${userId}`,
      userId,
    });
    const response = await fetch(`${apiBase}/projects/user/${userId}`, {
      method: "GET",
      headers: getCLIHeaders(token),
    });
    cliDebug("getProjects response", {
      status: response.status,
      ok: response.ok,
    });

    if (!response.ok) {
      if (response.status === 404) {
        return [];
      }
      throw new Error(`Failed to fetch projects: ${response.status}`);
    }

    const projects = await response.json();
    const parsedProjects = Array.isArray(projects) ? projects : [];
    cliDebug("getProjects parsed", {
      count: parsedProjects.length,
      names: parsedProjects.map((project) => project?.name),
    });
    return parsedProjects;
  } catch (error: any) {
    cliDebug("getProjects failed", {
      message: error?.message,
    });
    console.warn("Failed to fetch projects:", error.message);
    return [];
  }
};

// Fetch projects visible to the current identity. For service-account access keys,
// the backend returns only the credential's scoped projects.
export const getAccessibleProjects = async (
  baseUrl: string,
  token: string
): Promise<Project[]> => {
  const apiBase = normalizeApiBase(baseUrl);
  cliDebug("getAccessibleProjects request", {
    url: `${apiBase}/projects/`,
  });
  const response = await fetch(`${apiBase}/projects/`, {
    method: "GET",
    headers: getCLIHeaders(token),
  });
  cliDebug("getAccessibleProjects response", {
    status: response.status,
    ok: response.ok,
  });

  if (!response.ok) {
    if (response.status === 404) {
      return [];
    }
    throw new Error(`Failed to fetch projects: ${response.status}`);
  }

  const projects = await response.json();
  return Array.isArray(projects) ? projects : [];
};

const getPlaygroundProject = (projects: Project[]): Project | undefined =>
  projects.find((project) => project.name === PLAYGROUND_PROJECT_NAME);

const getUserDisplayName = (user: PlaygroundUser): string | undefined =>
  user.fullName || user.full_name || user.name;

const quickOnboardPlayground = async (
  baseUrl: string,
  token: string,
  user: PlaygroundUser,
  extraPayload: Record<string, unknown> = {}
): Promise<QuickOnboardResponse> => {
  if (!user.email) {
    throw new Error(
      "Playground project is missing and the authenticated user email is unavailable. Please login again."
    );
  }

  const apiBase = normalizeApiBase(baseUrl);
  const fullName = getUserDisplayName(user);
  const body = {
    email: user.email,
    ...(fullName ? { full_name: fullName } : {}),
    ...extraPayload,
  };
  cliDebug("quickOnboardPlayground request", {
    url: `${apiBase}/onboard/quick`,
    email: user.email,
    hasFullName: !!fullName,
    payloadKeys: Object.keys(body),
  });
  const response = await fetch(`${apiBase}/onboard/quick`, {
    method: "POST",
    headers: getCLIHeaders(token),
    body: JSON.stringify(body),
  });
  cliDebug("quickOnboardPlayground response", {
    status: response.status,
    ok: response.ok,
  });

  if (!response.ok) {
    const detail = await readResponseDetail(response);
    cliDebug("quickOnboardPlayground failed", {
      status: response.status,
      detail,
    });
    throw new Error(
      `Failed to run shared Playground onboarding: ${response.status} ${response.statusText}${
        detail ? ` - ${detail}` : ""
      }`
    );
  }

  const data = (await response.json()) as QuickOnboardResponse;
  cliDebug("quickOnboardPlayground parsed", {
    userId: data.user?.id,
    hasPlaygroundProject: !!data.playground_project?.id,
    hasDefaultConnection: !!data.default_connection?.id,
    setupJobs: data.setup_jobs?.map((job) => job.operation),
  });
  return data;
};

export const ensurePlaygroundProject = async (
  baseUrl: string,
  token: string,
  user: PlaygroundUser,
  options: { forceQuickOnboard?: boolean } = {}
): Promise<Project> => {
  cliDebug("ensurePlaygroundProject start", {
    userId: user.id,
    email: user.email,
    forceQuickOnboard: !!options.forceQuickOnboard,
  });
  const existingProjects = await getProjects(baseUrl, token, user.id);
  const existingPlayground = getPlaygroundProject(existingProjects);
  if (existingPlayground && !options.forceQuickOnboard) {
    cliDebug("ensurePlaygroundProject existing Playground found", {
      projectId: existingPlayground.id,
    });
    return existingPlayground;
  }

  const onboardResponse = await quickOnboardPlayground(baseUrl, token, user);
  if (onboardResponse.playground_project?.id) {
    cliDebug("ensurePlaygroundProject repaired from quick response", {
      projectId: onboardResponse.playground_project.id,
    });
    return onboardResponse.playground_project;
  }

  const refreshedProjects = await getProjects(baseUrl, token, user.id);
  const refreshedPlayground = getPlaygroundProject(refreshedProjects);
  if (refreshedPlayground) {
    cliDebug("ensurePlaygroundProject repaired after project refetch", {
      projectId: refreshedPlayground.id,
    });
    return refreshedPlayground;
  }

  throw new Error(
    "Shared onboarding completed, but no Playground project was returned or found."
  );
};

export const ensureDefaultProject = async (
  baseUrl: string,
  token: string,
  user: PlaygroundUser | string
): Promise<Project> =>
  ensurePlaygroundProject(
    baseUrl,
    token,
    typeof user === "string" ? { id: user } : user
  );

const readResponseDetail = async (response: Response): Promise<string | undefined> => {
  try {
    const raw = await response.text();
    if (!raw || !raw.trim()) {
      return undefined;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html") || /^\s*</.test(raw)) {
      return "backend returned an HTML error page; check --base-url/CLOUDEVAL_BASE_URL and backend health";
    }

    try {
      const json = JSON.parse(raw) as {
        message?: string;
        error?: string;
        error_description?: string;
        detail?: string;
      };
      return json.message || json.error_description || json.error || json.detail || raw;
    } catch {
      return raw;
    }
  } catch {
    return undefined;
  }
};

// Device Code Flow for user authentication
export const loginWithDeviceCode = async (
  baseUrl?: string,
  options: DeviceCodeLoginOptions = {}
): Promise<string> => {
  const apiBase = normalizeApiBase(baseUrl);
  const authBase = resolveAuthBootstrapBase(apiBase);
  const clientId = getCLIClientId();

  const requestBody = JSON.stringify({ client_id: clientId });

  cliDebug("backend device-code request", {
    url: `${authBase}/auth/device/code`,
    clientId,
  });
  const deviceCodeResponse = await fetch(`${authBase}/auth/device/code`, {
    method: "POST",
    headers: getCLIHeaders(),
    body: requestBody,
  });
  cliDebug("backend device-code response", {
    status: deviceCodeResponse.status,
    ok: deviceCodeResponse.ok,
  });

  if (!deviceCodeResponse.ok) {
    const statusInfo = `${deviceCodeResponse.status} ${deviceCodeResponse.statusText}`;
    const detail = await readResponseDetail(deviceCodeResponse);
    if (deviceCodeResponse.status === 401 || deviceCodeResponse.status === 403) {
      throw new Error(
        `CloudEval backend device-code login is blocked by an authentication layer (${statusInfo}${
          detail ? ` - ${detail}` : ""
        }). The CLI needs /api/v1/auth/device/code to stay public so it can show the CloudEval approval URL.`
      );
    }
    let errorMessage = `Failed to initiate login: ${statusInfo}`;
    if (detail) {
      errorMessage = `Failed to initiate login: ${statusInfo} - ${detail}`;
    }
    throw new Error(errorMessage);
  }

  return pollDeviceCodeAndPersist(authBase, clientId, deviceCodeResponse, {
    openInBrowser: options.openInBrowser,
    browserOpener: options.browserOpener,
    persistBaseUrl: apiBase,
  });
};

const pollDeviceCodeAndPersist = async (
  apiBase: string,
  clientId: string,
  deviceCodeResponse: Response,
  options: {
    openInBrowser?: boolean;
    browserOpener?: (url: string) => boolean;
    persistBaseUrl?: string;
  } = {}
): Promise<string> => {
  const deviceCodeData = (await deviceCodeResponse.json()) as DeviceCodeResponse;
  const verificationUrl = resolveDeviceVerificationUrl(deviceCodeData);
  const browserOpener = options.browserOpener ?? openBrowser;
  let openedInBrowser = false;
  cliDebug("backend device-code parsed", {
    hasVerificationUriComplete: !!deviceCodeData.verification_uri_complete,
    verificationUrl,
    userCode: deviceCodeData.user_code,
    expiresIn: deviceCodeData.expires_in,
    interval: deviceCodeData.interval,
  });

  if (options.openInBrowser && verificationUrl) {
    console.log("\nOpening browser for authentication...");
    openedInBrowser = browserOpener(verificationUrl);
    console.log(`Approval URL: ${verificationUrl}`);
  }

  if (!openedInBrowser) {
    console.log("\nTo sign in, use a web browser to open:");
    console.log(`  ${verificationUrl}`);
  }

  console.log(
    `\n${
      openedInBrowser ? "If prompted, enter code" : "Enter code"
    }: ${deviceCodeData.user_code}\n`
  );
  console.log("Waiting for authentication...");
  process.stdout.write("  ");

  const startTime = now();
  const expiresAt = startTime + deviceCodeData.expires_in * 1000;
  let intervalMs = Math.max(1, deviceCodeData.interval || 5) * 1000;

  while (now() < expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    const tokenResponse = await fetch(`${apiBase}/auth/device/token`, {
      method: "POST",
      headers: getCLIHeaders(),
      body: JSON.stringify({
        device_code: deviceCodeData.device_code,
        client_id: clientId,
      }),
    });
    cliDebug("backend device-token response", {
      status: tokenResponse.status,
      ok: tokenResponse.ok,
    });

    const tokenResponseForDetail = tokenResponse.clone();
    let tokenData: DeviceTokenResponse;
    try {
      tokenData = (await tokenResponse.json()) as DeviceTokenResponse;
    } catch {
      const detail = await readResponseDetail(tokenResponseForDetail);
      throw new Error(
        `Device token exchange failed: ${tokenResponse.status} ${tokenResponse.statusText}${
          detail ? ` - ${detail}` : ""
        }`
      );
    }

    if (tokenResponse.ok && tokenData.access_token) {
      const accessToken = persistAuthTokens(tokenData, {
        baseUrl: options.persistBaseUrl ?? apiBase,
      });
      cliDebug("backend device-token completed", {
        hasRefreshToken: !!tokenData.refresh_token,
        sessionId: tokenData.session_id,
        accountId: tokenData.account_id,
      });
      console.log("\nAuthentication successful. Session saved.\n");
      return accessToken;
    }

    if (tokenData.error === "authorization_pending") {
      process.stdout.write(".");
      continue;
    }

    if (tokenData.error === "slow_down" && tokenData.interval) {
      intervalMs = tokenData.interval * 1000;
      continue;
    }

    if (tokenData.error) {
      throw new Error(tokenData.error);
    }
  }

  throw new Error("Authentication timeout. Please try again.");
};

export const login = async (
  baseUrl?: string,
  options: LoginOptions = {}
): Promise<string> => {
  return loginWithDeviceCode(baseUrl, {
    openInBrowser: !options.headless,
    browserOpener: options.browserOpener,
  });
};

const refreshViaBackend = async (
  apiBase: string,
  refreshToken: string
): Promise<TokenResponse | null> => {
  const authBase = resolveAuthBootstrapBase(apiBase);
  const response = await fetch(`${authBase}/auth/refresh`, {
    method: "POST",
    headers: getCLIHeaders(),
    body: JSON.stringify({
      refresh_token: refreshToken,
      client_id: getCLIClientId(),
    }),
  });

  if (response.status === 404 || response.status === 405) {
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text();
    const lowerErrorText = errorText.toLowerCase();
    if (
      (response.status === 401 || response.status === 403) &&
      (lowerErrorText.includes("auth_required_public") ||
        lowerErrorText.includes("authentication required for this endpoint"))
    ) {
      return null;
    }
    throw new Error(errorText || "Token refresh failed");
  }

  return (await response.json()) as TokenResponse;
};

const refreshAuthToken = async (
  refreshToken: string,
  baseUrl?: string
): Promise<TokenResponse> => {
  const apiBase = normalizeApiBase(baseUrl);
  const backendResponse = await refreshViaBackend(apiBase, refreshToken);
  if (backendResponse) {
    return backendResponse;
  }
  throw new Error(
    "Token refresh unavailable from CloudEval backend. Run 'cloudeval login' and retry."
  );
};

const waitForConcurrentRefreshToken = async (
  previousRefreshToken: string
): Promise<string | undefined> => {
  for (const delayMs of CONCURRENT_REFRESH_WAIT_STEPS_MS) {
    await sleep(delayMs);
    const latest = reloadStored();
    const latestRefreshToken = getRefreshToken(latest);
    if (latestRefreshToken && latestRefreshToken !== previousRefreshToken) {
      return latestRefreshToken;
    }
  }

  const latest = reloadStored();
  const latestRefreshToken = getRefreshToken(latest);
  if (latestRefreshToken && latestRefreshToken !== previousRefreshToken) {
    return latestRefreshToken;
  }

  return undefined;
};

const resolveRefreshBaseUrl = (
  requestedBaseUrl: string | undefined,
  storedBaseUrl: string | undefined
): string | undefined => {
  if (!requestedBaseUrl) {
    return storedBaseUrl;
  }
  if (storedBaseUrl && normalizeApiBase(requestedBaseUrl) === DEFAULT_BASE_URL) {
    return storedBaseUrl;
  }
  return requestedBaseUrl;
};

const performRefresh = async (options: AuthOptions): Promise<string> => {
  const disk = readStored();
  const refreshToken = getRefreshToken(disk);
  if (!refreshToken) {
    throw new Error("No refresh token available. Please run 'cloudeval login'.");
  }

  const refreshBaseUrl = resolveRefreshBaseUrl(options.baseUrl, disk.baseUrl);
  const finishRefresh = async (
    currentRefreshToken: string,
    currentBaseUrl: string | undefined
  ): Promise<string> => {
    const refreshed = await refreshAuthToken(currentRefreshToken, currentBaseUrl);
    if (!refreshed.access_token) {
      throw new Error("Token refresh response missing access_token.");
    }

    return persistAuthTokens(refreshed, {
      baseUrl: normalizeApiBase(currentBaseUrl),
    });
  };

  try {
    return await finishRefresh(refreshToken, refreshBaseUrl);
  } catch (error) {
    let latest = reloadStored();
    let latestRefreshToken = getRefreshToken(latest);

    if (!latestRefreshToken || latestRefreshToken === refreshToken) {
      const waitedRefreshToken =
        await waitForConcurrentRefreshToken(refreshToken);
      if (waitedRefreshToken) {
        latest = reloadStored();
        latestRefreshToken = waitedRefreshToken;
      }
    }

    if (latestRefreshToken && latestRefreshToken !== refreshToken) {
      const latestBaseUrl =
        resolveRefreshBaseUrl(options.baseUrl, latest.baseUrl) || refreshBaseUrl;
      return finishRefresh(latestRefreshToken, latestBaseUrl);
    }

    throw error;
  }
};

const refreshWithSingleFlight = async (options: AuthOptions): Promise<string> => {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    const releaseRefreshLock = await acquireRefreshLock();
    try {
      return await performRefresh(options);
    } finally {
      releaseRefreshLock();
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
};

export const logout = async (
  options: LogoutOptions = {}
): Promise<{ revoked: boolean; localCleared: boolean }> => {
  const disk = readStored();
  const refreshToken = getRefreshToken(disk);
  const currentToken = cachedToken?.token || getAccessToken(disk);

  let revoked = false;
  if (refreshToken) {
    try {
      const apiBase = normalizeApiBase(options.baseUrl || disk.baseUrl);
      const endpoint = options.allDevices ? "/auth/logout-all" : "/auth/logout";
      const response = await fetch(`${apiBase}${endpoint}`, {
        method: "POST",
        headers: getCLIHeaders(currentToken),
        body: JSON.stringify({
          refresh_token: refreshToken,
          session_id: disk.sessionId,
        }),
      });

      if (response.ok || response.status === 404 || response.status === 405) {
        revoked = response.ok;
      }
    } catch {
      // Best effort revoke only.
    }
  }

  clearLocalAuth(disk);
  return { revoked, localCleared: true };
};

export const getAuthStatus = async (
  baseUrl?: string,
  options: AuthStatusOptions = {}
): Promise<AuthStatus> => {
  let disk = readStored();
  let refreshToken = getRefreshToken(disk);
  let accessToken = getAccessToken(disk);
  let accessTokenCached = Boolean(
    (cachedToken && cachedToken.expiresAt > now()) ||
      (accessToken && disk.tokenExpiresAt && disk.tokenExpiresAt > now())
  );
  let authenticated = Boolean(accessTokenCached || refreshToken);
  let authError: string | undefined;

  if (options.validate && authenticated) {
    try {
      const validationBaseUrl = resolveRefreshBaseUrl(baseUrl, disk.baseUrl);
      const token = await getAuthToken({ baseUrl: validationBaseUrl });
      if (validationBaseUrl) {
        await checkUserStatus(validationBaseUrl, token);
      }
      disk = readStored();
      refreshToken = getRefreshToken(disk);
      accessToken = getAccessToken(disk);
      accessTokenCached = Boolean(
        (cachedToken && cachedToken.expiresAt > now()) ||
          (accessToken && disk.tokenExpiresAt && disk.tokenExpiresAt > now())
      );
      authenticated = true;
    } catch (error) {
      authError = errorMessage(error);
      disk = readStored();
      refreshToken = getRefreshToken(disk);
      accessToken = getAccessToken(disk);
      accessTokenCached = Boolean(
        (cachedToken && cachedToken.expiresAt > now()) ||
          (accessToken && disk.tokenExpiresAt && disk.tokenExpiresAt > now())
      );
      authenticated = false;
    }
  }

  return {
    authenticated,
    accessTokenCached,
    accessTokenExpiresAt: cachedToken?.expiresAt ?? disk.tokenExpiresAt,
    hasRefreshToken: Boolean(refreshToken),
    sessionId: disk.sessionId,
    accountId: disk.accountId,
    baseUrl: disk.baseUrl || baseUrl,
    storageBackend: detectSecretBackend(),
    validationAttempted: options.validate,
    authError,
  };
};

// Extract email from JWT token
export const extractEmailFromToken = (token: string): string | null => {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8")
    ) as {
      email?: string;
      upn?: string;
      preferred_username?: string;
    };

    return payload.email || payload.upn || payload.preferred_username || null;
  } catch {
    return null;
  }
};

const AUTH_LOOKUP_ERROR = "CloudEvalAuthLookupError";

const authLookupError = async (response: Response, context: string): Promise<Error> => {
  let detail = "";
  try {
    const body = await response.text();
    if (body) {
      detail = ` - ${body.slice(0, 300)}`;
    }
  } catch {
    // ignore response body parsing errors
  }
  const error = new Error(`${context} failed: ${response.status} ${response.statusText}${detail}`);
  error.name = AUTH_LOOKUP_ERROR;
  return error;
};

const isAuthLookupError = (error: unknown): boolean =>
  error instanceof Error && error.name === AUTH_LOOKUP_ERROR;

export const isAuthLookupFailure = (error: unknown): boolean => isAuthLookupError(error);

const clearStoredAuthIfTokenMatches = (token: string): boolean => {
  const disk = readStored();
  const diskAccessToken = getAccessToken(disk);
  if (cachedToken?.token === token || diskAccessToken === token) {
    clearLocalAuth(disk);
    return true;
  }
  return false;
};

const fetchCurrentUserFromServer = async (
  apiBase: string,
  token: string
): Promise<UserStatus["user"] | null> => {
  try {
    const startedAt = Date.now();
    cliDebug("fetchCurrentUserFromServer request", {
      url: `${apiBase}/auth/me`,
    });
    const response = await fetch(`${apiBase}/auth/me`, {
      method: "GET",
      headers: getCLIHeaders(token),
    });
    cliDebug("fetchCurrentUserFromServer response", {
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
    });

    if (response.status === 401 || response.status === 403) {
      throw await authLookupError(response, "Current user lookup");
    }

    if (!response.ok) {
      return null;
    }

    const user = (await response.json()) as UserStatus["user"] | null;
    if (!user?.id) {
      return null;
    }

    cliDebug("fetchCurrentUserFromServer parsed", {
      userId: user.id,
      email: user.email,
      onboardingCompleted: !!user.preferences?.onboarding?.completedAt,
    });
    return user;
  } catch (error) {
    if (isAuthLookupError(error)) {
      clearStoredAuthIfTokenMatches(token);
      throw error;
    }
    cliDebug("fetchCurrentUserFromServer failed", {
      message: errorMessage(error),
    });
    return null;
  }
};

// Check user status after login
export const checkUserStatus = async (
  baseUrl: string,
  token: string
): Promise<UserStatus> => {
  try {
    const apiBase = normalizeApiBase(baseUrl);
    cliDebug("checkUserStatus start", { apiBase });

    const currentUser = await fetchCurrentUserFromServer(apiBase, token);
    if (currentUser) {
      cliDebug("checkUserStatus resolved from /auth/me", {
        userId: currentUser.id,
        email: currentUser.email,
        onboardingCompleted: !!currentUser.preferences?.onboarding?.completedAt,
      });
      return {
        exists: true,
        onboardingCompleted: !!currentUser.preferences?.onboarding?.completedAt,
        user: currentUser,
      };
    }

    // Legacy fallback: derive email locally only if server endpoint is unavailable.
    const email = extractEmailFromToken(token);
    if (!email) {
      cliDebug("checkUserStatus no email claim; assuming existing completed user");
      return { exists: true, onboardingCompleted: true };
    }

    const startedAt = Date.now();
    cliDebug("checkUserStatus /user/email request", {
      url: `${apiBase}/user/email`,
      email,
    });
    const response = await fetch(`${apiBase}/user/email`, {
      method: "POST",
      headers: getCLIHeaders(token),
      body: JSON.stringify({ email }),
    });
    cliDebug("checkUserStatus /user/email response", {
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
    });

    if (response.status === 401 || response.status === 403) {
      throw await authLookupError(response, "User email lookup");
    }

    if (response.ok) {
      const user = await response.json();
      cliDebug("checkUserStatus /user/email parsed", {
        userId: user?.id,
        email: user?.email,
        onboardingCompleted: !!user.preferences?.onboarding?.completedAt,
      });
      return {
        exists: true,
        onboardingCompleted: !!user.preferences?.onboarding?.completedAt,
        user,
      };
    }
    if (response.status === 404) {
      cliDebug("checkUserStatus user missing");
      return { exists: false, onboardingCompleted: false };
    }

    cliDebug("checkUserStatus non-404 fallback", {
      status: response.status,
    });
    return { exists: true, onboardingCompleted: true };
  } catch (error) {
    if (isAuthLookupError(error)) {
      clearStoredAuthIfTokenMatches(token);
      throw error;
    }
    cliDebug("checkUserStatus failed; assuming completed for compatibility", {
      message: errorMessage(error),
    });
    return { exists: true, onboardingCompleted: true };
  }
};

// Complete minimal onboarding via API
export const completeOnboarding = async (
  baseUrl: string,
  token: string,
  data: {
    name: string;
    role: string;
    teamSize: string;
    goals: string[];
    cloudProvider: string;
  }
): Promise<void> => {
  try {
    const apiBase = normalizeApiBase(baseUrl);
    cliDebug("completeOnboarding start", {
      apiBase,
      name: data.name,
      role: data.role,
      teamSize: data.teamSize,
      goals: data.goals,
      cloudProvider: data.cloudProvider,
    });

    const serverUser = await fetchCurrentUserFromServer(apiBase, token);
    const fallbackEmail = extractEmailFromToken(token);
    const email = serverUser?.email || fallbackEmail;

    if (!email) {
      throw new Error("Could not determine user email. Please login again.");
    }

    const userStatus = await checkUserStatus(apiBase, token);
    const knownUserId = userStatus.user?.id || serverUser?.id;
    cliDebug("completeOnboarding identity resolved", {
      email,
      serverUserId: serverUser?.id,
      knownUserId,
      statusExists: userStatus.exists,
      statusOnboardingCompleted: userStatus.onboardingCompleted,
    });
    const onboarding = {
      role: data.role,
      teamSize: data.teamSize,
      primaryGoals: data.goals,
      cloudProvider: data.cloudProvider,
    };

    const onboardData = await quickOnboardPlayground(
      apiBase,
      token,
      {
        id: knownUserId || "pending",
        email,
        fullName: data.name,
      },
      {
        onboarding,
      }
    );

    const userId = onboardData.user?.id || knownUserId;

    if (!userId) {
      throw new Error("Onboarding completed but no user ID returned");
    }

    const persistedOnboarding = onboardData.user?.preferences?.onboarding;
    const hasPersistedCompletion =
      !!persistedOnboarding?.completedAt || !!onboardData.onboarding_completed_at;
    cliDebug("completeOnboarding quick result", {
      userId,
      hasPersistedCompletion,
      hasPlaygroundProject: !!onboardData.playground_project?.id,
      setupJobs: onboardData.setup_jobs?.map((job) => job.operation),
    });

    if (!hasPersistedCompletion) {
      const preferences = {
        onboarding: {
          ...onboarding,
          completedAt: new Date().toISOString(),
        },
      };

      cliDebug("completeOnboarding fallback PATCH request", {
        url: `${apiBase}/users/${userId}`,
      });
      const response = await fetch(`${apiBase}/users/${userId}`, {
        method: "PATCH",
        headers: getCLIHeaders(token),
        body: JSON.stringify({ preferences }),
      });
      cliDebug("completeOnboarding fallback PATCH response", {
        status: response.status,
        ok: response.ok,
      });

      if (!response.ok) {
        const error = await response
          .json()
          .catch(() => ({ message: "Failed to complete onboarding" }));
        throw new Error(error.message || "Failed to complete onboarding");
      }
    }

    if (!onboardData.playground_project?.id) {
      cliDebug("completeOnboarding quick response missing Playground; repairing");
      await ensurePlaygroundProject(apiBase, token, {
        id: userId,
        email,
        fullName: data.name,
      });
    }
    cliDebug("completeOnboarding finished", {
      userId,
      email,
    });
  } catch (error: any) {
    cliDebug("completeOnboarding failed", {
      message: error?.message,
    });
    if (error?.message) {
      throw error;
    }
    throw new Error("Failed to complete onboarding");
  }
};

export const getAuthToken = async (options: AuthOptions = {}): Promise<string> => {
  if (options.accessKey) {
    return options.accessKey;
  }

  const minValidUntil = now() + TOKEN_EXPIRY_SKEW_MS;

  if (!options.forceRefresh && cachedToken && cachedToken.expiresAt > minValidUntil) {
    return cachedToken.token;
  }

  const disk = readStored();
  const refreshToken = getRefreshToken(disk);
  const accessToken = getAccessToken(disk);
  let refreshError: unknown;

  if (
    !options.forceRefresh &&
    accessToken &&
    disk.tokenExpiresAt &&
    disk.tokenExpiresAt > minValidUntil
  ) {
    cachedToken = { token: accessToken, expiresAt: disk.tokenExpiresAt };
    return accessToken;
  }

  if (refreshToken) {
    try {
      return await refreshWithSingleFlight(options);
    } catch (error) {
      refreshError = error;
      if (isRejectedRefreshTokenError(error)) {
        clearLocalAuth(disk);
      }
      // Refresh token may be revoked; force interactive re-login path.
    }
  }

  const loginHint =
    "No authentication available. Run 'cloudeval login' to authenticate or use --access-key-stdin for automation.";
  if (refreshError) {
    throw new Error(`${loginHint} Stored refresh failed: ${errorMessage(refreshError)}`);
  }
  throw new Error(loginHint);
};

export const getAuthHeader = async (
  options: AuthOptions = {}
): Promise<Record<string, string>> => {
  const token = await getAuthToken(options);
  return { Authorization: `Bearer ${token}` };
};
