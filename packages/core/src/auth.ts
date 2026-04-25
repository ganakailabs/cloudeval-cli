import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";

const DEFAULT_BACKEND_CLIENT_ID = "6ee27ab2-3637-43e1-ac26-58c55f8ba7bc";
const DEFAULT_BACKEND_TENANT_ID = "06f18712-6c3a-4b61-9475-bf2c226971b3";
const DEFAULT_BACKEND_SCOPE =
  "api://6ee27ab2-3637-43e1-ac26-58c55f8ba7bc/access_as_user offline_access";
const DEFAULT_BACKEND_DEFAULT_SCOPE =
  "api://6ee27ab2-3637-43e1-ac26-58c55f8ba7bc/.default";
const DEFAULT_BASE_URL = "https://cloudeval.ai/api/v1";
const TOKEN_EXPIRY_SKEW_MS = 120_000;
const REFRESH_SECRET_LABEL = "refresh-token";
const INSECURE_FILE_FALLBACK_ENV = "CLOUDEVAL_ALLOW_INSECURE_FILE_STORAGE";
const CONCURRENT_REFRESH_WAIT_STEPS_MS = [50, 100, 150, 250];
const REFRESH_LOCK_WAIT_STEP_MS = 100;
const REFRESH_LOCK_STALE_MS = 30_000;

const KEYCHAIN_SERVICE = "cloudeval-cli";
const KEYCHAIN_LABEL = "Cloudeval CLI";

export const getBackendClientId = () =>
  process.env.CLOUDEVAL_BACKEND_CLIENT_ID ?? DEFAULT_BACKEND_CLIENT_ID;
const getBackendTenantId = () =>
  process.env.CLOUDEVAL_BACKEND_TENANT_ID ?? DEFAULT_BACKEND_TENANT_ID;

const requireBackendAuthConfig = () => {
  const clientId = getBackendClientId();
  const tenantId = getBackendTenantId();
  if (!clientId || !tenantId) {
    throw new Error(
      "Missing backend auth config. Set CLOUDEVAL_BACKEND_CLIENT_ID and CLOUDEVAL_BACKEND_TENANT_ID."
    );
  }
  return { clientId, tenantId };
};

const defaultBackendScopeForClient = (clientId: string) =>
  clientId === DEFAULT_BACKEND_CLIENT_ID
    ? DEFAULT_BACKEND_SCOPE
    : `api://${clientId}/access_as_user offline_access`;

const defaultBackendDefaultScopeForClient = (clientId: string) =>
  clientId === DEFAULT_BACKEND_CLIENT_ID
    ? DEFAULT_BACKEND_DEFAULT_SCOPE
    : `api://${clientId}/.default`;

const getBackendScope = (clientId: string) =>
  process.env.CLOUDEVAL_BACKEND_SCOPE ?? defaultBackendScopeForClient(clientId);

const getBackendDefaultScope = (clientId: string) =>
  process.env.CLOUDEVAL_BACKEND_DEFAULT_SCOPE ??
  defaultBackendDefaultScopeForClient(clientId);

const resolveDefaultScope = () => {
  const clientId = getBackendClientId();
  return clientId ? getBackendDefaultScope(clientId) : undefined;
};

interface AzureAuthConfig {
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
  scope?: string;
}

interface AuthOptions {
  apiKey?: string;
  azure?: AzureAuthConfig;
  baseUrl?: string;
  allowMachineAuth?: boolean;
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
  allowDirectAzureFallback?: boolean;
  openInBrowser?: boolean;
  browserOpener?: (url: string) => boolean;
}

interface CliLoginStartResponse {
  authorization_url?: string;
  auth_url?: string;
  url?: string;
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

const base64Url = (input: Buffer) =>
  input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

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
      execFileSync("security", [
        "delete-generic-password",
        "-a",
        key,
        "-s",
        KEYCHAIN_SERVICE,
      ]);
    } else if (backend === "linux-libsecret") {
      execFileSync("secret-tool", [
        "clear",
        "service",
        KEYCHAIN_SERVICE,
        "account",
        key,
      ]);
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
  return raw.endsWith("/api/v1")
    ? raw
    : raw.replace(/\/api\/?$/, "") + "/api/v1";
};

const sanitizeStoredForDisk = (data: StoredAuth): StoredAuth => {
  const clone: StoredAuth = { ...data };
  delete clone.token;
  delete clone.refreshToken;
  return clone;
};

const migrateLegacySecrets = (parsed: StoredAuth): StoredAuth => {
  const migrated: StoredAuth = { ...parsed };

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

    if (nextStored.token) {
      cachedToken = {
        token: nextStored.token,
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

const buildDeviceVerificationUrl = (override: string, userCode?: string): string => {
  const url = new URL(override);
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/device/login";
  }
  if (userCode) {
    url.searchParams.set("user_code", userCode);
  }
  return url.toString();
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
  return deviceCodeData.verification_uri_complete || deviceCodeData.verification_uri;
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

const createPkceVerifier = (): string => base64Url(randomBytes(48));
const createPkceChallenge = (verifier: string): string =>
  base64Url(createHash("sha256").update(verifier).digest());

const createOpaqueState = (): string => base64Url(randomBytes(24));

const createLoopbackCallback = async (state: string) => {
  const server = http.createServer();

  const codePromise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Authentication timeout waiting for browser callback."));
      try {
        server.close();
      } catch {
        // no-op
      }
    }, 180_000);

    server.on("request", (req, res) => {
      const requestUrl = new URL(req.url || "/", "http://127.0.0.1");

      if (requestUrl.pathname !== "/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const receivedState = requestUrl.searchParams.get("state") || "";
      const code = requestUrl.searchParams.get("code");
      const error = requestUrl.searchParams.get("error");
      const errorDescription =
        requestUrl.searchParams.get("error_description") || "Authentication failed";

      if (error) {
        res.statusCode = 400;
        res.end("Authentication failed. You can close this tab.");
        clearTimeout(timeout);
        reject(new Error(`${error}: ${errorDescription}`));
        server.close();
        return;
      }

      if (!code || receivedState !== state) {
        res.statusCode = 400;
        res.end("Invalid authentication response. You can close this tab.");
        clearTimeout(timeout);
        reject(new Error("State mismatch during browser authentication."));
        server.close();
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        "<html><body><h3>Authentication complete.</h3><p>You can return to the CLI.</p></body></html>"
      );
      clearTimeout(timeout);
      resolve(code);
      server.close();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start local callback server for authentication.");
  }

  const redirectUri = `http://127.0.0.1:${address.port}/callback`;

  return {
    redirectUri,
    codePromise,
    close: () =>
      new Promise<void>((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      }),
  };
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
  };
  playground_project?: Project;
  default_connection?: {
    id?: string;
    name?: string;
  };
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
    const response = await fetch(`${apiBase}/projects/user/${userId}`, {
      method: "GET",
      headers: getCLIHeaders(token),
    });

    if (!response.ok) {
      if (response.status === 404) {
        return [];
      }
      throw new Error(`Failed to fetch projects: ${response.status}`);
    }

    const projects = await response.json();
    return Array.isArray(projects) ? projects : [];
  } catch (error: any) {
    console.warn("Failed to fetch projects:", error.message);
    return [];
  }
};

const getPlaygroundProject = (projects: Project[]): Project | undefined =>
  projects.find((project) => project.name === PLAYGROUND_PROJECT_NAME);

const getUserDisplayName = (user: PlaygroundUser): string | undefined =>
  user.fullName || user.full_name || user.name;

const quickOnboardPlayground = async (
  baseUrl: string,
  token: string,
  user: PlaygroundUser
): Promise<QuickOnboardResponse> => {
  if (!user.email) {
    throw new Error(
      "Playground project is missing and the authenticated user email is unavailable. Please login again."
    );
  }

  const apiBase = normalizeApiBase(baseUrl);
  const fullName = getUserDisplayName(user);
  const response = await fetch(`${apiBase}/onboard/quick`, {
    method: "POST",
    headers: getCLIHeaders(token),
    body: JSON.stringify({
      email: user.email,
      ...(fullName ? { full_name: fullName } : {}),
    }),
  });

  if (!response.ok) {
    const detail = await readResponseDetail(response);
    throw new Error(
      `Failed to run shared Playground onboarding: ${response.status} ${response.statusText}${
        detail ? ` - ${detail}` : ""
      }`
    );
  }

  return (await response.json()) as QuickOnboardResponse;
};

export const ensurePlaygroundProject = async (
  baseUrl: string,
  token: string,
  user: PlaygroundUser
): Promise<Project> => {
  const existingProjects = await getProjects(baseUrl, token, user.id);
  const existingPlayground = getPlaygroundProject(existingProjects);
  if (existingPlayground) {
    return existingPlayground;
  }

  const onboardResponse = await quickOnboardPlayground(baseUrl, token, user);
  const refreshedProjects = await getProjects(baseUrl, token, user.id);
  const refreshedPlayground = getPlaygroundProject(refreshedProjects);
  if (refreshedPlayground) {
    return refreshedPlayground;
  }

  if (onboardResponse.playground_project?.id) {
    return onboardResponse.playground_project;
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

const azureEnvConfig = (): AzureAuthConfig => ({
  clientId: process.env.AZURE_AD_CLIENT_ID ?? process.env.AZURE_CLIENT_ID,
  clientSecret:
    process.env.AZURE_AD_CLIENT_SECRET ?? process.env.AZURE_CLIENT_SECRET,
  tenantId: process.env.AZURE_AD_TENANT_ID ?? process.env.AZURE_TENANT_ID,
  scope:
    process.env.AZURE_AD_SCOPE ??
    process.env.AZURE_SCOPE ??
    resolveDefaultScope(),
});

const isAzureConfigured = (cfg: AzureAuthConfig) =>
  !!(cfg.clientId && cfg.clientSecret && cfg.tenantId);

const fetchAzureToken = async (cfg: AzureAuthConfig): Promise<string> => {
  const { clientId, clientSecret, tenantId, scope } = cfg;
  if (!clientId || !clientSecret || !tenantId) {
    throw new Error(
      "Missing Azure AD config (AZURE_AD_CLIENT_ID/SECRET/TENANT_ID)"
    );
  }

  const resolvedScope = scope ?? resolveDefaultScope();
  if (!resolvedScope) {
    throw new Error(
      "Missing Azure AD scope. Set AZURE_AD_SCOPE/AZURE_SCOPE or CLOUDEVAL_BACKEND_CLIENT_ID/CLOUDEVAL_BACKEND_DEFAULT_SCOPE."
    );
  }

  const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: resolvedScope,
  });

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Azure AD token request failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  if (!json.access_token) {
    throw new Error("Azure AD token response missing access_token");
  }

  setCachedToken(json.access_token, json.expires_in);
  return json.access_token;
};

const getAzurePublicClientConfig = () => {
  const { clientId, tenantId } = requireBackendAuthConfig();
  return {
    clientId,
    tenantId,
    scope: getBackendScope(clientId),
  };
};

const getAzureTokenEndpoint = (tenantId: string) =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

const shouldUseDirectAzureFallback = (status?: number): boolean =>
  status === 401 || status === 403 || status === 404 || status === 405;

const readResponseDetail = async (response: Response): Promise<string | undefined> => {
  try {
    const raw = await response.text();
    if (!raw || !raw.trim()) {
      return undefined;
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

const buildAzureAuthorizeUrl = (options: {
  tenantId: string;
  clientId: string;
  scope: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}) => {
  const url = new URL(
    `https://login.microsoftonline.com/${options.tenantId}/oauth2/v2.0/authorize`
  );
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", options.scope);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", options.state);
  return url.toString();
};

const exchangeAzureAuthCode = async (options: {
  tenantId: string;
  clientId: string;
  scope: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenResponse> => {
  const response = await fetch(getAzureTokenEndpoint(options.tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: options.clientId,
      code: options.code,
      redirect_uri: options.redirectUri,
      code_verifier: options.codeVerifier,
      scope: options.scope,
    }).toString(),
  });

  if (!response.ok) {
    const detail = await readResponseDetail(response);
    throw new Error(
      `Azure AD auth code exchange failed: ${response.status}${
        detail ? ` - ${detail}` : ""
      }`
    );
  }

  return (await response.json()) as TokenResponse;
};

const loginWithDirectAzurePkceBrowser = async (baseUrl?: string): Promise<string> => {
  const apiBase = normalizeApiBase(baseUrl);
  const { clientId, tenantId, scope } = getAzurePublicClientConfig();
  const state = createOpaqueState();
  const codeVerifier = createPkceVerifier();
  const codeChallenge = createPkceChallenge(codeVerifier);
  const { redirectUri, codePromise, close } = await createLoopbackCallback(state);

  try {
    const authorizationUrl = buildAzureAuthorizeUrl({
      tenantId,
      clientId,
      scope,
      redirectUri,
      codeChallenge,
      state,
    });

    console.log("\nOpening browser for authentication...");
    if (!openBrowser(authorizationUrl)) {
      console.log("Could not open browser automatically. Open this URL manually:");
      console.log(`  ${authorizationUrl}`);
    }

    const code = await codePromise;
    const tokenData = await exchangeAzureAuthCode({
      tenantId,
      clientId,
      scope,
      code,
      redirectUri,
      codeVerifier,
    });

    if (!tokenData.access_token) {
      throw new Error("Azure AD token response missing access_token");
    }

    return persistAuthTokens(tokenData, { baseUrl: apiBase });
  } finally {
    await close();
  }
};

const requestAzureDeviceCode = async (): Promise<DeviceCodeResponse> => {
  const { clientId, tenantId, scope } = getAzurePublicClientConfig();
  const response = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/devicecode`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        scope,
      }).toString(),
    }
  );

  if (!response.ok) {
    const detail = await readResponseDetail(response);
    throw new Error(
      `Azure AD device-code login failed: ${response.status}${
        detail ? ` - ${detail}` : ""
      }`
    );
  }

  return (await response.json()) as DeviceCodeResponse;
};

const loginWithDirectAzureDeviceCode = async (baseUrl?: string): Promise<string> => {
  const apiBase = normalizeApiBase(baseUrl);
  const deviceCodeData = await requestAzureDeviceCode();
  const { clientId, tenantId } = getAzurePublicClientConfig();

  console.log("\nTo sign in, use a web browser to open:");
  console.log(`  ${deviceCodeData.verification_uri}`);
  console.log(`\nEnter code: ${deviceCodeData.user_code}\n`);
  console.log("Waiting for authentication...");
  process.stdout.write("  ");

  const expiresAt = now() + deviceCodeData.expires_in * 1000;
  let intervalMs = Math.max(1, deviceCodeData.interval || 5) * 1000;

  while (now() < expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    const response = await fetch(getAzureTokenEndpoint(tenantId), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: deviceCodeData.device_code,
      }).toString(),
    });

    const tokenData = (await response.json()) as DeviceTokenResponse;

    if (response.ok && tokenData.access_token) {
      const accessToken = persistAuthTokens(tokenData, { baseUrl: apiBase });
      console.log("\nAuthentication successful. Session saved.\n");
      return accessToken;
    }

    if (tokenData.error === "authorization_pending") {
      process.stdout.write(".");
      continue;
    }

    if (tokenData.error === "slow_down") {
      intervalMs += 5000;
      continue;
    }

    if (tokenData.error) {
      throw new Error(tokenData.error);
    }
  }

  throw new Error("Authentication timeout. Please try again.");
};

const loginWithPkceBrowser = async (
  baseUrl?: string,
  options: { browserOpener?: (url: string) => boolean } = {}
): Promise<string> => {
  const apiBase = normalizeApiBase(baseUrl);
  const clientId = getCLIClientId();
  const state = createOpaqueState();
  const codeVerifier = createPkceVerifier();
  const codeChallenge = createPkceChallenge(codeVerifier);

  const { redirectUri, codePromise, close } = await createLoopbackCallback(state);

  try {
    const startResponse = await fetch(`${apiBase}/auth/cli/login/start`, {
      method: "POST",
      headers: getCLIHeaders(),
      body: JSON.stringify({
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
      }),
    });

    if (!startResponse.ok) {
      if (shouldUseDirectAzureFallback(startResponse.status)) {
        throw new Error(
          `Backend browser login bootstrap unavailable: ${startResponse.status} ${startResponse.statusText}`
        );
      }
      throw new Error(
        `Failed to initiate browser login: ${startResponse.status} ${startResponse.statusText}`
      );
    }

    const startData = (await startResponse.json()) as CliLoginStartResponse;
    const authorizationUrl =
      startData.authorization_url || startData.auth_url || startData.url;

    if (!authorizationUrl) {
      throw new Error("Browser login start response did not include authorization URL.");
    }

    const browserOpener = options.browserOpener ?? openBrowser;
    console.log("\nOpening browser for authentication...");
    if (!browserOpener(authorizationUrl)) {
      console.log("Could not open browser automatically. Open this URL manually:");
      console.log(`  ${authorizationUrl}`);
    }

    const code = await codePromise;

    const tokenResponse = await fetch(`${apiBase}/auth/token`, {
      method: "POST",
      headers: getCLIHeaders(),
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        state,
      }),
    });

    if (!tokenResponse.ok) {
      const text = await tokenResponse.text();
      throw new Error(`Failed to exchange auth code: ${tokenResponse.status} ${text}`);
    }

    const tokenData = (await tokenResponse.json()) as TokenResponse;
    if (!tokenData.access_token) {
      throw new Error("Token response missing access_token");
    }

    return persistAuthTokens(tokenData, { baseUrl: apiBase });
  } finally {
    await close();
  }
};

// Device Code Flow for user authentication
export const loginWithDeviceCode = async (
  baseUrl?: string,
  options: DeviceCodeLoginOptions = {}
): Promise<string> => {
  const apiBase = normalizeApiBase(baseUrl);
  const clientId = getCLIClientId();

  const requestBody = JSON.stringify({ client_id: getCLIClientId() });

  const deviceCodeResponse = await fetch(`${apiBase}/auth/device/code`, {
    method: "POST",
    headers: getCLIHeaders(),
    body: requestBody,
  });

  if (!deviceCodeResponse.ok) {
    const statusInfo = `${deviceCodeResponse.status} ${deviceCodeResponse.statusText}`;

    if (deviceCodeResponse.status === 404) {
      // Backward compatibility with existing endpoint path.
      return loginWithLegacyDeviceEndpoints(apiBase, clientId, requestBody, options);
    }

    if (
      options.allowDirectAzureFallback !== false &&
      shouldUseDirectAzureFallback(deviceCodeResponse.status)
    ) {
      console.warn("Backend device-code login unavailable. Falling back to direct Azure AD device flow.");
      return loginWithDirectAzureDeviceCode(baseUrl);
    }

    let errorMessage = `Failed to initiate login: ${statusInfo}`;
    const detail = await readResponseDetail(deviceCodeResponse);
    if (detail) {
      errorMessage = `Failed to initiate login: ${statusInfo} - ${detail}`;
    }
    throw new Error(errorMessage);
  }

  return pollDeviceCodeAndPersist(apiBase, clientId, deviceCodeResponse, {
    openInBrowser: options.openInBrowser,
    browserOpener: options.browserOpener,
  });
};

const loginWithLegacyDeviceEndpoints = async (
  apiBase: string,
  clientId: string,
  requestBody: string,
  options: DeviceCodeLoginOptions = {}
): Promise<string> => {
  const deviceCodeResponse = await fetch(`${apiBase}/device/code`, {
    method: "POST",
    headers: getCLIHeaders(),
    body: requestBody,
  });

  if (!deviceCodeResponse.ok) {
    const statusInfo = `${deviceCodeResponse.status} ${deviceCodeResponse.statusText}`;
    throw new Error(`Failed to initiate login: ${statusInfo}`);
  }

  return pollDeviceCodeAndPersist(apiBase, clientId, deviceCodeResponse, {
    useLegacyEndpoints: true,
    openInBrowser: options.openInBrowser,
    browserOpener: options.browserOpener,
  });
};

const pollDeviceCodeAndPersist = async (
  apiBase: string,
  clientId: string,
  deviceCodeResponse: Response,
  options: {
    useLegacyEndpoints?: boolean;
    openInBrowser?: boolean;
    browserOpener?: (url: string) => boolean;
  } = {}
): Promise<string> => {
  const deviceCodeData = (await deviceCodeResponse.json()) as DeviceCodeResponse;
  const verificationUrl = resolveDeviceVerificationUrl(deviceCodeData);
  const browserOpener = options.browserOpener ?? openBrowser;
  let openedInBrowser = false;

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
  const tokenPath = options.useLegacyEndpoints
    ? "/device/token"
    : "/auth/device/token";

  while (now() < expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    const tokenResponse = await fetch(`${apiBase}${tokenPath}`, {
      method: "POST",
      headers: getCLIHeaders(),
      body: JSON.stringify({
        device_code: deviceCodeData.device_code,
        client_id: clientId,
      }),
    });

    const tokenData = (await tokenResponse.json()) as DeviceTokenResponse;

    if (tokenResponse.ok && tokenData.access_token) {
      const accessToken = persistAuthTokens(tokenData, { baseUrl: apiBase });
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
  if (options.headless) {
    return loginWithDeviceCode(baseUrl, {
      allowDirectAzureFallback: true,
    });
  }

  try {
    return await loginWithDeviceCode(baseUrl, {
      allowDirectAzureFallback: false,
      openInBrowser: true,
      browserOpener: options.browserOpener,
    });
  } catch (error: any) {
    const message = String(error?.message || "");
    const shouldFallback =
      message.includes("Failed to initiate login: 401") ||
      message.includes("Failed to initiate login: 403") ||
      message.includes("Failed to initiate login: 404") ||
      message.includes("Failed to initiate login: 405") ||
      message.includes("verification_uri");

    if (!shouldFallback) {
      throw error;
    }

    try {
      console.warn(
        "Browser-assisted device login unavailable. Falling back to backend PKCE login."
      );
      return await loginWithPkceBrowser(baseUrl, {
        browserOpener: options.browserOpener,
      });
    } catch (pkceError: any) {
      const pkceMessage = String(pkceError?.message || "");
      const shouldFallbackToAzure =
        pkceMessage.includes("Backend browser login bootstrap unavailable") ||
        pkceMessage.includes("Failed to initiate browser login: 401") ||
        pkceMessage.includes("Failed to initiate browser login: 403") ||
        pkceMessage.includes("Failed to initiate browser login: 404") ||
        pkceMessage.includes("Failed to initiate browser login: 405") ||
        pkceMessage.includes("authorization URL");

      if (!shouldFallbackToAzure) {
        throw pkceError;
      }

      console.warn(
        "Backend browser PKCE login unavailable. Falling back to direct Azure AD PKCE."
      );
      return loginWithDirectAzurePkceBrowser(baseUrl);
    }
  }
};

const refreshViaBackend = async (
  apiBase: string,
  refreshToken: string
): Promise<TokenResponse | null> => {
  const response = await fetch(`${apiBase}/auth/refresh`, {
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
    throw new Error(errorText || "Token refresh failed");
  }

  return (await response.json()) as TokenResponse;
};

const refreshViaAzure = async (refreshToken: string): Promise<TokenResponse> => {
  const { clientId, tenantId } = requireBackendAuthConfig();
  const backendScope = getBackendScope(clientId);
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
      scope: backendScope,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
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
  return refreshViaAzure(refreshToken);
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

const performRefresh = async (options: AuthOptions): Promise<string> => {
  const disk = readStored();
  const refreshToken = getRefreshToken(disk);
  if (!refreshToken) {
    throw new Error("No refresh token available. Please run 'cloudeval login'.");
  }

  const refreshBaseUrl = options.baseUrl || disk.baseUrl;
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
      const latestBaseUrl = options.baseUrl || latest.baseUrl || refreshBaseUrl;
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
  const currentToken =
    cachedToken?.token || (disk.tokenExpiresAt && disk.token ? disk.token : undefined);

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

export const getAuthStatus = async (baseUrl?: string): Promise<AuthStatus> => {
  const disk = readStored();
  const refreshToken = getRefreshToken(disk);

  return {
    authenticated: Boolean(
      (cachedToken && cachedToken.expiresAt > now()) || refreshToken
    ),
    accessTokenCached: Boolean(cachedToken && cachedToken.expiresAt > now()),
    accessTokenExpiresAt: cachedToken?.expiresAt,
    hasRefreshToken: Boolean(refreshToken),
    sessionId: disk.sessionId,
    accountId: disk.accountId,
    baseUrl: disk.baseUrl || baseUrl,
    storageBackend: detectSecretBackend(),
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

const fetchCurrentUserFromServer = async (
  apiBase: string,
  token: string
): Promise<UserStatus["user"] | null> => {
  try {
    const response = await fetch(`${apiBase}/auth/me`, {
      method: "GET",
      headers: getCLIHeaders(token),
    });

    if (!response.ok) {
      return null;
    }

    const user = (await response.json()) as UserStatus["user"] | null;
    if (!user?.id) {
      return null;
    }

    return user;
  } catch {
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

    const currentUser = await fetchCurrentUserFromServer(apiBase, token);
    if (currentUser) {
      return {
        exists: true,
        onboardingCompleted: !!currentUser.preferences?.onboarding?.completedAt,
        user: currentUser,
      };
    }

    // Legacy fallback: derive email locally only if server endpoint is unavailable.
    const email = extractEmailFromToken(token);
    if (!email) {
      return { exists: true, onboardingCompleted: true };
    }

    const response = await fetch(`${apiBase}/user/email`, {
      method: "POST",
      headers: getCLIHeaders(token),
      body: JSON.stringify({ email }),
    });

    if (response.ok) {
      const user = await response.json();
      return {
        exists: true,
        onboardingCompleted: !!user.preferences?.onboarding?.completedAt,
        user,
      };
    }
    if (response.status === 404) {
      return { exists: false, onboardingCompleted: false };
    }

    return { exists: true, onboardingCompleted: true };
  } catch {
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

    const serverUser = await fetchCurrentUserFromServer(apiBase, token);
    const fallbackEmail = extractEmailFromToken(token);
    const email = serverUser?.email || fallbackEmail;

    if (!email) {
      throw new Error("Could not determine user email. Please login again.");
    }

    const userStatus = await checkUserStatus(apiBase, token);
    const knownUserId = userStatus.user?.id || serverUser?.id;

    const onboardData = await quickOnboardPlayground(apiBase, token, {
      id: knownUserId || "pending",
      email,
      fullName: data.name,
    });

    const userId = onboardData.user?.id || knownUserId;

    if (!userId) {
      throw new Error("Onboarding completed but no user ID returned");
    }

    const preferences = {
      onboarding: {
        role: data.role,
        teamSize: data.teamSize,
        primaryGoals: data.goals,
        cloudProvider: data.cloudProvider,
        completedAt: new Date().toISOString(),
      },
    };

    const response = await fetch(`${apiBase}/users/${userId}`, {
      method: "PATCH",
      headers: getCLIHeaders(token),
      body: JSON.stringify({ preferences }),
    });

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ message: "Failed to complete onboarding" }));
      throw new Error(error.message || "Failed to complete onboarding");
    }

    await ensurePlaygroundProject(apiBase, token, {
      id: userId,
      email,
      fullName: data.name,
    });
  } catch (error: any) {
    if (error?.message) {
      throw error;
    }
    throw new Error("Failed to complete onboarding");
  }
};

export const getAuthToken = async (options: AuthOptions = {}): Promise<string> => {
  if (options.apiKey) {
    return options.apiKey;
  }

  const minValidUntil = now() + TOKEN_EXPIRY_SKEW_MS;

  if (cachedToken && cachedToken.expiresAt > minValidUntil) {
    return cachedToken.token;
  }

  const disk = readStored();
  const refreshToken = getRefreshToken(disk);

  if (disk.token && disk.tokenExpiresAt && disk.tokenExpiresAt > minValidUntil) {
    cachedToken = { token: disk.token, expiresAt: disk.tokenExpiresAt };
    // Remove persisted access token from disk after migration.
    writeStored({ ...disk, token: undefined });
    return disk.token;
  }

  if (refreshToken) {
    try {
      return await refreshWithSingleFlight(options);
    } catch {
      // Refresh token may be revoked; force interactive re-login path.
    }
  }

  if (options.allowMachineAuth) {
    const azureCfg = { ...azureEnvConfig(), ...(options.azure ?? {}) };
    if (isAzureConfigured(azureCfg)) {
      return fetchAzureToken(azureCfg);
    }
  }

  throw new Error(
    "No authentication available. Run 'cloudeval login' to authenticate. For machine auth, provide --machine with service credentials or use --api-key-stdin."
  );
};

export const getAuthHeader = async (
  options: AuthOptions = {}
): Promise<Record<string, string>> => {
  const token = await getAuthToken(options);
  return { Authorization: `Bearer ${token}` };
};
