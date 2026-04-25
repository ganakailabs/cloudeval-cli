import type { Command } from "commander";

export interface AuthGuardOptions {
  baseUrl?: string;
  apiKey?: string;
  apiKeyStdin?: boolean;
  machine?: boolean;
  nonInteractive?: boolean;
}

export interface AuthGuardDeps {
  resolveBaseUrl: (
    options: { baseUrl?: string },
    command?: Command
  ) => Promise<string>;
  readStdinValue: () => Promise<string>;
  isHeadlessEnvironment: () => boolean;
}

export interface AuthContext {
  baseUrl: string;
  token: string;
  user?: {
    id: string;
    email?: string;
    full_name?: string;
    name?: string;
  };
}

const isInteractive = (options: AuthGuardOptions): boolean =>
  !options.nonInteractive &&
  process.stdin.isTTY === true &&
  process.stdout.isTTY === true &&
  !process.env.CI;

export const resolveAuthContext = async (
  options: AuthGuardOptions,
  command: Command | undefined,
  deps: AuthGuardDeps
): Promise<AuthContext> => {
  const baseUrl = await deps.resolveBaseUrl(options, command);
  const core = await import("@cloudeval/core");
  core.assertSecureBaseUrl(baseUrl);

  let apiKey = options.apiKey;
  if (options.apiKeyStdin) {
    apiKey = await deps.readStdinValue();
  }

  let token = apiKey;
  if (!token) {
    try {
      token = await core.getAuthToken({
        apiKey,
        baseUrl,
        allowMachineAuth: !!options.machine,
      });
    } catch (error: any) {
      if (!isInteractive(options) || options.machine) {
        throw error;
      }
      process.stderr.write("Authentication required. Starting login flow...\n");
      token = await core.login(baseUrl, {
        headless: deps.isHeadlessEnvironment(),
      });
      process.stderr.write("Authentication successful.\n");
    }
  }

  const status = await core.checkUserStatus(baseUrl, token);
  return {
    baseUrl,
    token,
    user: status.user,
  };
};

export const requireAuthUser = (context: AuthContext): AuthContext & {
  user: NonNullable<AuthContext["user"]>;
} => {
  if (!context.user?.id) {
    throw new Error("Authenticated user id is unavailable. Run `cloudeval login` and retry.");
  }
  return context as AuthContext & { user: NonNullable<AuthContext["user"]> };
};

export const addAuthOptions = <T extends Command>(command: T, defaultBaseUrl: string): T =>
  command
    .option("--base-url <url>", "Backend base URL", defaultBaseUrl)
    .option(
      "--api-key <key>",
      "API key (machine workflows only; deprecated for interactive human auth)",
      process.env.CLOUDEVAL_API_KEY
    )
    .option("--api-key-stdin", "Read API key from stdin (recommended for automation)", false)
    .option("--machine", "Allow machine credential fallback (service principal)", false)
    .option("--non-interactive", "Disable prompts and browser login", false) as T;
