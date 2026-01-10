import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_BACKEND_CLIENT_ID = "6ee27ab2-3637-43e1-ac26-58c55f8ba7bc";
const DEFAULT_BACKEND_TENANT_ID = "06f18712-6c3a-4b61-9475-bf2c226971b3";
const DEFAULT_BACKEND_SCOPE =
  "api://6ee27ab2-3637-43e1-ac26-58c55f8ba7bc/access_as_user offline_access";
const DEFAULT_BACKEND_DEFAULT_SCOPE =
  "api://6ee27ab2-3637-43e1-ac26-58c55f8ba7bc/.default";

const getBackendClientId = () =>
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

const getBackendScope = (clientId: string) =>
  process.env.CLOUDEVAL_BACKEND_SCOPE ??
  DEFAULT_BACKEND_SCOPE ??
  `api://${clientId}/access_as_user offline_access`;

const getBackendDefaultScope = (clientId: string) =>
  process.env.CLOUDEVAL_BACKEND_DEFAULT_SCOPE ??
  DEFAULT_BACKEND_DEFAULT_SCOPE ??
  `api://${clientId}/.default`;

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
  baseUrl?: string; // Add baseUrl for refresh token support
}

interface StoredAuth {
  token?: string;
  tokenExpiresAt?: number;
  refreshToken?: string;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface UserStatus {
  exists: boolean;
  onboardingCompleted: boolean;
  user?: {
    id: string;
    email: string;
    preferences?: {
      onboarding?: {
        completedAt?: number;
      };
    };
  };
}

let cachedToken: { token: string; expiresAt: number } | null = null;
let stored: StoredAuth | null = null;

const now = () => Date.now();

const configPath = path.join(
  os.homedir(),
  ".config",
  "cloudeval",
  "config.json"
);

const readStored = (): StoredAuth => {
  if (stored) return stored;
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    stored = JSON.parse(raw) as StoredAuth;
  } catch {
    stored = {};
  }
  return stored;
};

const writeStored = (data: StoredAuth) => {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), "utf8");
    stored = data;
  } catch {
    // ignore persistence errors; remain in-memory
  }
};

// Logout: Clear stored authentication tokens
export const logout = (): void => {
  try {
    // Clear in-memory cache
    cachedToken = null;
    stored = null;
    
    // Clear stored tokens from disk
    const emptyAuth: StoredAuth = {};
    writeStored(emptyAuth);
    
    // Optionally delete the config file entirely
    try {
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
      }
    } catch {
      // If deletion fails, at least we cleared the content
    }
  } catch (error) {
    // Ignore errors during logout
  }
};

// Project interface matching frontend
export interface Project {
  id: string;
  name: string;
  user_id?: string; // Optional for CLI default project
  description?: string;
  cloud_provider?: string;
  type?: "template" | "sync";
  connection_ids?: string[];
  created_at?: string;
  updated_at?: string;
}

// Helper to get CLI client headers
const getCLIHeaders = (token?: string): Record<string, string> => {
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
    // Ensure baseUrl ends with /api/v1 (frontend uses /api/v1 as base)
    const apiBase = baseUrl.endsWith("/api/v1") 
      ? baseUrl 
      : baseUrl.replace(/\/api\/?$/, "") + "/api/v1";
    
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
    throw new Error("Missing Azure AD config (AZURE_AD_CLIENT_ID/SECRET/TENANT_ID)");
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

  cachedToken = {
    token: json.access_token,
    expiresAt: now() + json.expires_in * 1000 - 60_000, // expire 1m early
  };
  writeStored({
    ...(readStored() ?? {}),
    token: cachedToken.token,
    tokenExpiresAt: cachedToken.expiresAt,
  });

  return json.access_token;
};

// Device Code Flow for user authentication
export const loginWithDeviceCode = async (): Promise<string> => {
  const { clientId, tenantId } = requireBackendAuthConfig();
  const backendScope = getBackendScope(clientId);

  // Step 1: Get device code
  const deviceCodeUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/devicecode`;
  
  const deviceCodeResponse = await fetch(deviceCodeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      scope: backendScope,
    }).toString(),
  });

  if (!deviceCodeResponse.ok) {
    const error = await deviceCodeResponse.text();
    throw new Error(`Failed to initiate login: ${error}`);
  }

  const deviceCodeData = (await deviceCodeResponse.json()) as DeviceCodeResponse;

  // Display instructions
  console.log("\n🔐 To sign in, use a web browser to open:");
  console.log(`   ${deviceCodeData.verification_uri}`);
  console.log(`\n   Enter code: ${deviceCodeData.user_code}\n`);
  console.log("Waiting for authentication...");
  process.stdout.write("   ");

  // Step 2: Poll for token
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const startTime = Date.now();
  const expiresAt = startTime + deviceCodeData.expires_in * 1000;

  while (Date.now() < expiresAt) {
    await new Promise((resolve) =>
      setTimeout(resolve, deviceCodeData.interval * 1000)
    );

    const tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: deviceCodeData.device_code,
      }).toString(),
    });

    if (tokenResponse.ok) {
      const tokenData = (await tokenResponse.json()) as TokenResponse;

      // Save tokens
      cachedToken = {
        token: tokenData.access_token,
        expiresAt: Date.now() + tokenData.expires_in * 1000 - 60_000, // 1 min buffer
      };

      writeStored({
        ...(readStored() ?? {}),
        token: tokenData.access_token,
        tokenExpiresAt: cachedToken.expiresAt,
        refreshToken: tokenData.refresh_token,
      });

      console.log("\n✅ Authentication successful! Token saved.\n");
      return tokenData.access_token;
    }

    const error = await tokenResponse.json();
    if (error.error === "authorization_pending") {
      process.stdout.write(".");
      continue;
    } else if (error.error === "slow_down") {
      // Increase polling interval
      await new Promise((resolve) =>
        setTimeout(resolve, (deviceCodeData.interval + 5) * 1000)
      );
      continue;
    } else {
      throw new Error(error.error_description || error.error);
    }
  }

  throw new Error("Authentication timeout. Please try again.");
};

// Refresh token function
const refreshAuthToken = async (
  refreshToken: string
): Promise<TokenResponse> => {
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
    const error = await response.json();
    throw new Error(error.error_description || "Token refresh failed");
  }

  return (await response.json()) as TokenResponse;
};

// Extract email from JWT token (Azure AD tokens contain email in payload)
export const extractEmailFromToken = (token: string): string | null => {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    
    // Decode the payload (second part)
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8")
    );
    
    // Azure AD tokens have email in 'upn', 'email', or 'preferred_username'
    return payload.email || payload.upn || payload.preferred_username || null;
  } catch {
    return null;
  }
};

// Check user status after login (matches frontend: POST /user/email)
export const checkUserStatus = async (
  baseUrl: string,
  token: string
): Promise<UserStatus> => {
  try {
    // Extract email from token
    const email = extractEmailFromToken(token);
    if (!email) {
      // If we can't extract email, assume user exists (backward compat)
      return { exists: true, onboardingCompleted: true };
    }

    // Use same endpoint as frontend: POST /user/email
    // Ensure baseUrl ends with /api/v1 (frontend uses /api/v1 as base)
    const apiBase = baseUrl.endsWith("/api/v1") 
      ? baseUrl 
      : baseUrl.replace(/\/api\/?$/, "") + "/api/v1";
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
    } else if (response.status === 404) {
      return { exists: false, onboardingCompleted: false };
    } else {
      // If endpoint doesn't exist or returns error, assume user exists (backward compat)
      return { exists: true, onboardingCompleted: true };
    }
  } catch {
    // If check fails, assume user exists (backward compat)
    return { exists: true, onboardingCompleted: true };
  }
};

// Complete minimal onboarding via API (matches frontend: creates user if needed, then updates preferences)
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
    // Extract email from token to create/update user
    const email = extractEmailFromToken(token);
    if (!email) {
      throw new Error("Could not extract email from token. Please login again.");
    }

    // Ensure baseUrl ends with /api/v1 (frontend uses /api/v1 as base)
    const apiBase = baseUrl.endsWith("/api/v1") 
      ? baseUrl 
      : baseUrl.replace(/\/api\/?$/, "") + "/api/v1";
    
    // First, check if user exists
    let userStatus = await checkUserStatus(baseUrl, token);
    let userId: string;

    if (!userStatus.exists || !userStatus.user?.id) {
      // User doesn't exist - create them first (like frontend quickOnboardUser)
      // Use POST /onboard/quick to create user with playground
      const quickOnboardResponse = await fetch(`${apiBase}/onboard/quick`, {
        method: "POST",
        headers: getCLIHeaders(token),
        body: JSON.stringify({
          email,
          full_name: data.name,
        }),
      });

      if (!quickOnboardResponse.ok) {
        const error = await quickOnboardResponse.json().catch(() => ({ message: "Failed to create user" }));
        throw new Error(error.message || "Failed to create user");
      }

      const onboardData = await quickOnboardResponse.json();
      userId = onboardData.user?.id;
      
      if (!userId) {
        throw new Error("User created but no user ID returned");
      }
    } else {
      userId = userStatus.user.id;
    }

    // Now update preferences with onboarding data
    // Use same endpoint as frontend: PATCH /users/{userId}
    // Match frontend structure: preferences.onboarding.{role, teamSize, primaryGoals, cloudProvider}
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
      const error = await response.json().catch(() => ({ message: "Failed to complete onboarding" }));
      throw new Error(error.message || "Failed to complete onboarding");
    }
  } catch (error: any) {
    if (error.message) {
      throw error;
    }
    throw new Error("Failed to complete onboarding");
  }
};

export const getAuthToken = async (options: AuthOptions = {}): Promise<string> => {
  if (options.apiKey) {
    return options.apiKey;
  }

  // Check cached token
  if (cachedToken && cachedToken.expiresAt > now()) {
    return cachedToken.token;
  }

  // Check stored token
  const disk = readStored();
  if (disk.token && disk.tokenExpiresAt) {
    // If token is expired but we have refresh token, try to refresh
    if (disk.tokenExpiresAt <= now() && disk.refreshToken) {
      try {
        const refreshed = await refreshAuthToken(disk.refreshToken);
        cachedToken = {
          token: refreshed.access_token,
          expiresAt: Date.now() + refreshed.expires_in * 1000 - 60_000,
        };
        writeStored({
          ...disk,
          token: refreshed.access_token,
          tokenExpiresAt: cachedToken.expiresAt,
          refreshToken: refreshed.refresh_token || disk.refreshToken,
        });
        return refreshed.access_token;
      } catch (error) {
        // Refresh failed - token might be revoked, will prompt for re-login
        // Don't throw here, let it fall through to show the login message
      }
    } else if (disk.tokenExpiresAt > now()) {
      cachedToken = { token: disk.token, expiresAt: disk.tokenExpiresAt };
      return disk.token;
    }
  }

  // Try Azure AD client credentials if configured (for service accounts)
  const azureCfg = { ...azureEnvConfig(), ...(options.azure ?? {}) };
  if (isAzureConfigured(azureCfg)) {
    return fetchAzureToken(azureCfg);
  }

  throw new Error(
    "No authentication available. Run 'cloudeval login' to authenticate, or provide --api-key/CLOUDEVAL_API_KEY or Azure AD env vars (AZURE_AD_CLIENT_ID/SECRET/TENANT_ID)."
  );
};

export const getAuthHeader = async (
  options: AuthOptions = {}
): Promise<Record<string, string>> => {
  const token = await getAuthToken(options);
  return { Authorization: `Bearer ${token}` };
};
