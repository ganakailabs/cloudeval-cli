import assert from "node:assert/strict";
import test from "node:test";
import { resolveReportProjectId } from "./reportProject";

test("resolveReportProjectId uses explicit project id without fetching projects", async () => {
  const projectId = await resolveReportProjectId({
    baseUrl: "https://example.com/api/v1",
    token: "token-1",
    requestedProjectId: "project-explicit",
    workspace: {
      checkUserStatus: async () => {
        throw new Error("should not fetch user status");
      },
      getProjects: async () => {
        throw new Error("should not fetch projects");
      },
    },
  });

  assert.equal(projectId, "project-explicit");
});

test("resolveReportProjectId chooses Playground from authenticated user projects", async () => {
  const projectId = await resolveReportProjectId({
    baseUrl: "https://example.com/api/v1",
    token: "token-1",
    workspace: {
      checkUserStatus: async () => ({
        exists: true,
        onboardingCompleted: true,
        user: { id: "user-1" },
      }),
      getProjects: async () => [
        { id: "project-1", name: "Production", user_id: "user-1" },
        { id: "project-playground", name: "Playground", user_id: "user-1" },
      ],
    },
  });

  assert.equal(projectId, "project-playground");
});

test("resolveReportProjectId requires a real project when none can be discovered", async () => {
  await assert.rejects(
    () =>
      resolveReportProjectId({
        baseUrl: "https://example.com/api/v1",
        token: "token-1",
        workspace: {
          checkUserStatus: async () => ({
            exists: true,
            onboardingCompleted: true,
            user: { id: "user-1" },
          }),
          getProjects: async () => [],
        },
      }),
    /No projects found/
  );
});
