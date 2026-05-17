import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import {
  getBundledAgentProfile,
  getBundledAgentProfiles,
  type AgentProfile,
} from "@cloudeval/shared";
import { addAuthOptions, resolveAuthContext, type AuthGuardDeps } from "./authGuard.js";
import { getActiveConfigProfile, loadCliConfig } from "./cliConfig.js";
import { runLocalHooks, writeHookWarnings } from "./localHooks.js";
import {
  formatTextTable,
  writeFormattedOutput,
  writePrivateOutputFile,
  type MachineOutputFormat,
} from "./outputFormatter.js";
import { buildFrontendUrl, resolveFrontendBaseUrl } from "./frontendLinks.js";

interface AgentsDeps extends AuthGuardDeps {
  defaultBaseUrl: string;
}

interface AgentsOptions {
  baseUrl?: string;
  accessKey?: string;
  accessKeyStdin?: boolean;
  nonInteractive?: boolean;
  project?: string;
  model?: string;
  thread?: string;
  format?: MachineOutputFormat;
  output?: string;
  progress?: "none" | "stderr" | "ndjson" | string;
  hooks?: boolean;
  noHooks?: boolean;
  frontendUrl?: string;
  printUrl?: boolean;
}

const AGENT_PROFILE_STREAM_IDLE_TIMEOUT_MS = 180_000;

const addAgentOutputOptions = <T extends Command>(
  command: T,
  deps: AgentsDeps
): T =>
  addAuthOptions(command, deps.defaultBaseUrl)
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .option("--profile <name>", "Configuration profile") as T;

const textRows = (profiles: AgentProfile[]) =>
  profiles.map((profile) => ({
    id: profile.id,
    name: profile.display_name,
    mode: profile.default_mode,
    personality: profile.personality,
  }));

const writeProfiles = async (input: {
  command: string;
  data: unknown;
  profiles?: AgentProfile[];
  format?: MachineOutputFormat;
  output?: string;
}) => {
  if ((input.format === "text" || !input.format) && input.profiles) {
    process.stdout.write(formatTextTable(textRows(input.profiles)));
    return;
  }
  await writeFormattedOutput({
    command: input.command,
    data: input.data,
    format: input.format,
    output: input.output,
  });
};

const profileFromResponse = (payload: unknown): AgentProfile => {
  const record = payload && typeof payload === "object" ? (payload as any) : {};
  const profile = record.profile ?? record.data ?? record;
  if (!profile?.id) {
    throw new Error("Agent Profile response did not include a profile.");
  }
  return profile as AgentProfile;
};

const listProfilesForDiscovery = async (
  core: typeof import("@cloudeval/core"),
  baseUrl: string,
) => {
  try {
    return await core.listAgentProfiles({
      baseUrl,
    });
  } catch (error) {
    if (core.isAgentProfileDiscoveryFallbackError(error)) {
      return { profiles: getBundledAgentProfiles() };
    }
    throw error;
  }
};

const getProfileForDiscovery = async (
  core: typeof import("@cloudeval/core"),
  baseUrl: string,
  profileId: string,
) => {
  try {
    return await core.getAgentProfile({
      baseUrl,
      profileId,
    });
  } catch (error) {
    if (core.isAgentProfileDiscoveryFallbackError(error)) {
      const profile = getBundledAgentProfile(profileId);
      if (!profile) {
        throw new Error(`Unknown Agent Profile "${profileId}".`);
      }
      return { profile };
    }
    throw error;
  }
};

const projectStarterPromptType = (project: any): "template" | "sync" =>
  String(project?.project_data_source ?? project?.type ?? "")
    .trim()
    .toLowerCase() === "template"
    ? "template"
    : "sync";

const starterModeForProfile = (profile: AgentProfile): "ask" | "agent" =>
  profile.default_settings?.mode ?? profile.default_mode ?? "agent";

const chooseStarterVariant = (
  variants: NonNullable<AgentProfile["starter_prompt_variants"]>,
): string => {
  if (variants.length === 0) {
    return "";
  }
  return variants[0]?.text?.trim() || "";
};

const starterPromptForProject = (
  profile: AgentProfile,
  project: any,
): string => {
  const projectSource = projectStarterPromptType(project);
  const mode = starterModeForProfile(profile);
  const variants =
    profile.starter_prompt_variants?.filter(
      (variant) =>
        variant.project_source === projectSource &&
        variant.mode === mode &&
        variant.text.trim(),
    ) || [];
  const variantPrompt = chooseStarterVariant(variants);
  return (
    variantPrompt ||
    profile.starter_prompts?.[projectSource]?.trim() ||
    profile.starter_prompt
  );
};

const resolveProject = async (
  core: typeof import("@cloudeval/core"),
  auth: { baseUrl: string; token: string; user?: { id?: string } },
  projectId?: string
): Promise<any> => {
  const projects = auth.user?.id
    ? await core.getProjects(auth.baseUrl, auth.token, auth.user.id)
    : [];
  if (projectId) {
    const project = projects.find((candidate: any) => candidate.id === projectId);
    if (project) {
      return project;
    }
    return {
      id: projectId,
      name: "Selected Project",
      user_id: auth.user?.id,
      cloud_provider: "azure",
      type: "sync",
    };
  }
  if (!auth.user?.id) {
    throw new Error("Use --project when running an Agent Profile with an access key.");
  }
  const first = projects[0];
  if (!first) {
    throw new Error("No CloudEval project is available. Pass --project or create a project first.");
  }
  return first;
};

export const registerAgentsCommand = (program: Command, deps: AgentsDeps) => {
  const agents = program
    .command("agents")
    .description("CloudEval Agent Profile utilities");

  addAgentOutputOptions(agents.command("list").description("List Agent Profiles"), deps)
    .action(async (options: AgentsOptions, command) => {
      const baseUrl = await deps.resolveBaseUrl(options, command);
      const core = await import("@cloudeval/core");
      core.assertSecureBaseUrl(baseUrl);
      const data = await listProfilesForDiscovery(core, baseUrl);
      await writeProfiles({
        command: "agents list",
        data,
        profiles: data.profiles,
        format: options.format,
        output: options.output,
      });
    });

  addAgentOutputOptions(
    agents.command("show").description("Show an Agent Profile").argument("<profile_id>"),
    deps
  ).action(async (profileId: string, options: AgentsOptions, command) => {
    const baseUrl = await deps.resolveBaseUrl(options, command);
    const core = await import("@cloudeval/core");
    core.assertSecureBaseUrl(baseUrl);
    const data = await getProfileForDiscovery(core, baseUrl, profileId);
    await writeProfiles({
      command: "agents show",
      data,
      profiles: [profileFromResponse(data)],
      format: options.format,
      output: options.output,
    });
  });

  addAgentOutputOptions(
    agents
      .command("run")
      .description("Run an Agent Profile")
      .argument("<profile_id>")
      .argument("[prompt...]"),
    deps
  )
    .option("--project <id>", "Project ID to use")
    .option("--model <name>", "Model override")
    .option("--thread <id>", "Thread id to reuse")
    .option("--progress <mode>", "Progress events: stderr, ndjson, none", "none")
    .option("--frontend-url <url>", "Frontend base URL")
    .option("--print-url", "Print the frontend chat thread URL", false)
    .option("--no-hooks", "Disable local CLI hooks for this command")
    .action(
      async (
        profileId: string,
        promptParts: string[],
        options: AgentsOptions,
        command
      ) => {
        const cliProfile = getActiveConfigProfile(command);
        const cliConfig = await loadCliConfig(cliProfile);
        const auth = await resolveAuthContext(options, command, deps);
        const core = await import("@cloudeval/core");
        const profileResponse = await core.getAgentProfile({
          baseUrl: auth.baseUrl,
          authToken: auth.token,
          profileId,
        });
        const profile = profileFromResponse(profileResponse);
        const projectId = options.project ?? cliConfig.defaultProjectId;
        const project = await resolveProject(core, auth, projectId);
        const prompt = promptParts?.length
          ? promptParts.join(" ")
          : starterPromptForProject(profile, project);
        const threadId = options.thread ?? randomUUID();
        const hooksDisabled = options.hooks === false || options.noHooks === true;
        const warnings = await runLocalHooks({
          event: "cli.command.before",
          config: cliConfig,
          profile: cliProfile,
          commandName: "agents run",
          projectId: project.id,
          agentProfileId: profile.id,
          threadId,
          noHooks: hooksDisabled,
        });
        warnings.push(
          ...(await runLocalHooks({
            event: "agent_profile.run.before",
            config: cliConfig,
            profile: cliProfile,
            commandName: "agents run",
            projectId: project.id,
            agentProfileId: profile.id,
            threadId,
            noHooks: hooksDisabled,
          }))
        );
        writeHookWarnings(warnings);

        let responseText = "";
        let chatState: any = { ...core.initialChatState, threadId };
        try {
          for await (const chunk of core.streamChat({
            baseUrl: auth.baseUrl,
            authToken: auth.token,
            message: prompt,
            threadId,
            user: {
              id: project.user_id ?? auth.user?.id ?? "cli-user",
              name: auth.user?.name ?? "You",
            },
            project,
            settings: {
              ...(options.model ?? cliConfig.model
                ? { model: options.model ?? cliConfig.model }
                : {}),
              mode: starterModeForProfile(profile),
            },
            agentProfileId: profile.id,
            completeAfterResponse: true,
            responseCompletionGraceMs: 5000,
            streamIdleTimeoutMs: AGENT_PROFILE_STREAM_IDLE_TIMEOUT_MS,
          })) {
            chatState = core.reduceChunk(chatState, chunk);
            if (
              options.progress === "ndjson" &&
              (chunk.type === "thinking" || chunk.type === "responding")
            ) {
              process.stdout.write(`${JSON.stringify({ type: "progress", chunk })}\n`);
            }
            if (chunk.type === "responding" && chunk.content) {
              responseText =
                [...chatState.messages]
                  .reverse()
                  .find((message: any) => message.role === "assistant")
                  ?.content || chunk.content;
            }
            if (chunk.type === "error") {
              throw new Error(chunk.message || chunk.description || "Agent Profile run failed.");
            }
          }
          const finalResponse =
            [...chatState.messages]
              .reverse()
              .find((message: any) => message.role === "assistant")
              ?.content || responseText;
          const frontendUrl = buildFrontendUrl({
            baseUrl: resolveFrontendBaseUrl({
              frontendUrl: options.frontendUrl ?? cliConfig.frontendUrl,
              apiBaseUrl: auth.baseUrl,
            }),
            target: "chat",
            threadId,
          });
          await runLocalHooks({
            event: "agent_profile.run.after",
            config: cliConfig,
            profile: cliProfile,
            commandName: "agents run",
            projectId: project.id,
            agentProfileId: profile.id,
            threadId,
            noHooks: hooksDisabled,
            extra: { ok: true },
          }).then(writeHookWarnings);
          await runLocalHooks({
            event: "cli.command.after",
            config: cliConfig,
            profile: cliProfile,
            commandName: "agents run",
            projectId: project.id,
            agentProfileId: profile.id,
            threadId,
            noHooks: hooksDisabled,
            extra: { ok: true },
          }).then(writeHookWarnings);
          const result = {
            profile,
            prompt,
            response: finalResponse,
            threadId,
            project: { id: project.id, name: project.name },
            frontendUrl,
          };
          if ((options.format ?? "text") === "text" || options.format === "markdown") {
            const outputText = finalResponse ? `${finalResponse}\n` : "";
            if (options.output) {
              await writePrivateOutputFile(options.output, outputText);
            } else {
              process.stdout.write(outputText);
            }
          } else {
            await writeFormattedOutput({
              command: "agents run",
              data: result,
              format: options.format,
              output: options.output,
            });
          }
          if (options.printUrl) {
            process.stderr.write(`${frontendUrl}\n`);
          }
          process.exit(0);
        } catch (error: any) {
          await runLocalHooks({
            event: "agent_profile.run.error",
            config: cliConfig,
            profile: cliProfile,
            commandName: "agents run",
            projectId: project.id,
            agentProfileId: profile.id,
            threadId,
            noHooks: hooksDisabled,
            extra: { error: error?.message },
          }).then(writeHookWarnings);
          await runLocalHooks({
            event: "cli.command.error",
            config: cliConfig,
            profile: cliProfile,
            commandName: "agents run",
            projectId: project.id,
            agentProfileId: profile.id,
            threadId,
            noHooks: hooksDisabled,
            extra: { error: error?.message },
          }).then(writeHookWarnings);
          throw error;
        }
      }
    );
};
