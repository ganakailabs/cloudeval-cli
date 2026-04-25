export type ReportWorkspace = {
  checkUserStatus: (
    baseUrl: string,
    token: string
  ) => Promise<{ user?: { id?: string }; exists?: boolean; onboardingCompleted?: boolean }>;
  getProjects: (
    baseUrl: string,
    token: string,
    userId: string
  ) => Promise<Array<{ id: string; name: string; user_id?: string }>>;
};

export interface ResolveReportProjectIdOptions {
  baseUrl: string;
  token?: string;
  requestedProjectId?: string;
  workspace?: ReportWorkspace;
}

export const resolveReportProjectId = async ({
  baseUrl,
  token,
  requestedProjectId,
  workspace,
}: ResolveReportProjectIdOptions): Promise<string> => {
  if (requestedProjectId) {
    return requestedProjectId;
  }
  if (!token) {
    throw new Error("No project specified. Use --project <id> for report access.");
  }

  const resolvedWorkspace: ReportWorkspace =
    workspace ??
    (await import("@cloudeval/core").then((core) => ({
      checkUserStatus: core.checkUserStatus,
      getProjects: core.getProjects,
    })));

  const userStatus = await resolvedWorkspace.checkUserStatus(baseUrl, token);
  const userId = userStatus.user?.id;
  if (!userId) {
    throw new Error("Could not determine the authenticated user. Use --project <id>.");
  }

  const projects = await resolvedWorkspace.getProjects(baseUrl, token, userId);
  const selected =
    projects.find((project) => project.name === "Playground") ?? projects[0];
  if (!selected?.id) {
    throw new Error("No projects found for the authenticated user.");
  }
  return selected.id;
};
