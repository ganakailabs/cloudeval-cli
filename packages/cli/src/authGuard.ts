import type { Command } from "commander";

export interface AuthGuardOptions {
  baseUrl?: string;
  accessKey?: string;
  accessKeyStdin?: boolean;
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

const isCloudEvalAccessKey = (value?: string): value is string =>
  /^cev_[a-z0-9]+_ak_[A-Za-z0-9]+_.+$/i.test(String(value ?? "").trim());

export const resolveAuthContext = async (
  options: AuthGuardOptions,
  command: Command | undefined,
  deps: AuthGuardDeps
): Promise<AuthContext> => {
  const baseUrl = await deps.resolveBaseUrl(options, command);
  const core = await import("@cloudeval/core");
  core.assertSecureBaseUrl(baseUrl);

  let accessKey = options.accessKey;
  if (options.accessKeyStdin) {
    accessKey = await deps.readStdinValue();
  }

  let token = accessKey;
  if (!token) {
    try {
      token = await core.getAuthToken({
        accessKey,
        baseUrl,
      });
    } catch (error: any) {
      if (!isInteractive(options)) {
        throw error;
      }
      process.stderr.write("Authentication required. Starting login flow...\n");
      token = await core.login(baseUrl, {
        headless: deps.isHeadlessEnvironment(),
      });
      process.stderr.write("Authentication successful.\n");
    }
  }

  if (isCloudEvalAccessKey(accessKey)) {
    return { baseUrl, token: accessKey };
  }

  let status;
  try {
    status = await core.checkUserStatus(baseUrl, token);
  } catch (error) {
    if (!accessKey && core.isAuthLookupFailure(error)) {
      throw new Error(
        "Stored authentication was rejected by CloudEval. Run `cloudeval login` and retry."
      );
    }
    throw error;
  }
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
      "--access-key <key>",
      "Access key for automation",
      process.env.CLOUDEVAL_ACCESS_KEY
    )
    .option("--access-key-stdin", "Read access key from stdin (recommended for automation)", false)
    .option("--non-interactive", "Disable prompts and browser login", false) as T;
