import type { Project } from "@cloudeval/core";

export type ResolveAskProjectInput = {
  baseUrl: string;
  token: string;
  selectedProjectId?: string;
  authenticatedUserId?: string;
  authenticatedUser?: {
    id: string;
    email?: string | null;
    full_name?: string | null;
    name?: string | null;
  };
};

/**
 * Resolve a full project record for non-interactive ask/agent streams.
 * Never returns a stub project: missing ids fail fast with a actionable error.
 */
export const resolveAskProject = async (
  input: ResolveAskProjectInput
): Promise<Project> => {
  const core = await import("@cloudeval/core");
  const { getProjects, ensurePlaygroundProject, checkUserStatus } = core;

  let userId = input.authenticatedUserId;
  let user = input.authenticatedUser;

  if (!userId) {
    const status = await checkUserStatus(input.baseUrl, input.token);
    userId = status.user?.id;
    user = status.user ?? user;
  }

  if (!userId) {
    throw new Error(
      "Could not determine the authenticated user. Run `cloudeval login` and retry."
    );
  }

  const projects = await getProjects(input.baseUrl, input.token, userId);

  if (input.selectedProjectId) {
    const match = projects.find((project) => project.id === input.selectedProjectId);
    if (!match) {
      throw new Error(
        `Project ${input.selectedProjectId} was not found for authenticated user ${userId}. ` +
          "Run `cloudeval projects list` to choose a visible project."
      );
    }
    return match;
  }

  const playground = projects.find((project) => project.name === "Playground");
  if (playground) {
    return playground;
  }

  if (user?.email) {
    return ensurePlaygroundProject(input.baseUrl, input.token, {
      id: userId,
      email: user.email,
      full_name: user.full_name ?? undefined,
      name: user.name ?? undefined,
    });
  }

  const fallback = projects[0];
  if (fallback) {
    return fallback;
  }

  throw new Error(
    "No project is available for this account. Run `cloudeval chat` to complete onboarding, then retry."
  );
};
