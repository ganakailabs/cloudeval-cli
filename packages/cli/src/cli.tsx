#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { Command } from "commander";
import { App } from "./ui/App";

const program = new Command();

program
  .name("cloudeval")
  .description("CloudEval CLI")
  .version("0.1.0");

program
  .command("login")
  .description("Authenticate with Cloudeval (opens browser)")
  .action(async () => {
    // Show banner for login
    const { Banner } = await import("./ui/components/Banner.js");
    const { render, Text, Box } = await import("ink");
    const React = await import("react");
    
    const LoginApp: React.FC = () => {
      const [status, setStatus] = React.useState<string>("Authenticating...");
      
      React.useEffect(() => {
        (async () => {
          try {
            const { loginWithDeviceCode } = await import("@cloudeval/core");
            await loginWithDeviceCode();
            setStatus("✅ Login successful!");
            setTimeout(() => process.exit(0), 1000);
          } catch (error: any) {
            setStatus(`❌ Login failed: ${error.message}`);
            setTimeout(() => process.exit(1), 2000);
          }
        })();
      }, []);
      
      return (
        <Box flexDirection="column" padding={1}>
          <Banner disable={false} />
          <Text>{status}</Text>
        </Box>
      );
    };
    
    render(React.createElement(LoginApp));
  });

program
  .command("logout")
  .description("Log out and clear stored authentication tokens")
  .action(async () => {
    try {
      const { logout } = await import("@cloudeval/core");
      logout();
      console.log("✅ Logged out successfully. Authentication tokens cleared.");
      process.exit(0);
    } catch (error: any) {
      console.error("❌ Logout failed:", error.message);
      process.exit(1);
    }
  });

program
  .command("chat")
  .description("Start an interactive chat session")
  .option(
    "--base-url <url>",
    "Backend base URL",
    process.env.CLOUDEVAL_BASE_URL ?? "http://localhost:8000/api/v1"
  )
  .option("--api-key <key>", "API key", process.env.CLOUDEVAL_API_KEY)
  .option("--conversation <id>", "Conversation/thread id to resume")
  .option("--model <name>", "Model name")
  .option("--debug", "Log raw chunks", false)
  .option("--health-check", "Enable health check (disabled by default)")
  .option("--no-banner", "Disable ASCII banner")
  .option("--no-anim", "Disable loader animation")
  .action((options) => {
    render(
      <App
        baseUrl={options.baseUrl}
        apiKey={options.apiKey}
        conversationId={options.conversation}
        model={options.model}
        debug={options.debug}
        disableBanner={options.banner === false}
        disableAnim={options.anim === false}
        skipHealthCheck={!options.healthCheck}
      />
    );
  });

program
  .command("ask")
  .description("Ask a single question (non-interactive)")
  .argument("<question>", "The question to ask")
  .option(
    "--base-url <url>",
    "Backend base URL",
    process.env.CLOUDEVAL_BASE_URL ?? "http://localhost:8000/api/v1"
  )
  .option("--api-key <key>", "API key", process.env.CLOUDEVAL_API_KEY)
  .option("--project <id>", "Project ID to use")
  .option("--model <name>", "Model name")
  .option("--output <file>", "Output file (default: stdout)")
  .option("--json", "Output as JSON")
  .option("--debug", "Log raw chunks", false)
  .action(async (question, options) => {
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const { randomUUID } = await import("node:crypto");
      const core = await import("@cloudeval/core");
      const shared = await import("@cloudeval/shared");
      const {
        streamChat,
        reduceChunk,
        getAuthToken,
        getProjects,
        checkUserStatus,
        extractEmailFromToken,
        initialChatState,
      } = core;
      
      // Import types - use any to avoid type conflicts for now
      type Project = any;
      type ChatState = any;

      // Get auth token
      let token = options.apiKey;
      if (!token) {
        token = await getAuthToken({ apiKey: options.apiKey, baseUrl: options.baseUrl });
      }

      // Get project
      let project: Project | undefined;
      if (options.project) {
        // If project ID provided, we'd need to fetch it
        // For now, use a basic project object
        project = {
          id: options.project,
          name: "CLI Project",
          user_id: "cli-user",
          cloud_provider: "azure",
        };
      } else {
        // Try to get user and fetch projects
        try {
          const email = extractEmailFromToken(token);
          if (email) {
            const userStatus = await checkUserStatus(options.baseUrl, token);
            if (userStatus.user?.id) {
              const projects = await getProjects(options.baseUrl, token, userStatus.user.id);
              const playgroundProject = projects.find((p) => p.name === "Playground");
              project = playgroundProject || projects[0] || undefined;
            }
          }
        } catch (error) {
          // Fallback to default project
        }

        if (!project) {
          project = {
            id: "cli-project",
            name: "CLI Project",
            user_id: "cli-user",
            cloud_provider: "azure",
          };
        }
      }

      // Get user name from token
      let userName = "You";
      try {
        const email = extractEmailFromToken(token);
        if (email) {
          const name = email.split("@")[0];
          userName = name.charAt(0).toUpperCase() + name.slice(1);
        }
      } catch {
        // Use default
      }

      // Stream the chat response
      const threadId = randomUUID();
      let chatState: ChatState = { ...initialChatState, threadId };
      let responseText = "";

      if (options.debug) {
        console.error(`[ask] Question: ${question}`);
        console.error(`[ask] Project: ${project.id} (${project.name})`);
        console.error(`[ask] Thread ID: ${threadId}`);
      }

      for await (const chunk of streamChat({
        baseUrl: options.baseUrl,
        authToken: token,
        message: question,
        threadId,
        user: { id: "cli-user", name: userName },
        project,
        settings: options.model ? { model: options.model } : undefined,
        debug: options.debug,
      })) {
        chatState = reduceChunk(chatState, chunk);

        // Extract the latest assistant message content
        const latestMessage = [...chatState.messages]
          .reverse()
          .find((m) => m.role === "assistant");
        
        if (latestMessage?.content) {
          responseText = latestMessage.content;
        }
      }

      // Get final response
      const finalMessage = [...chatState.messages]
        .reverse()
        .find((m) => m.role === "assistant");
      
      const finalResponse = finalMessage?.content || responseText || "";

      // Output the response
      if (options.json) {
        const output = {
          question,
          response: finalResponse,
          threadId: chatState.threadId,
          project: {
            id: project.id,
            name: project.name,
          },
        };
        const outputText = JSON.stringify(output, null, 2);
        
        if (options.output) {
          await fs.writeFile(options.output, outputText, "utf-8");
        } else {
          console.log(outputText);
        }
      } else {
        if (options.output) {
          await fs.writeFile(options.output, finalResponse, "utf-8");
        } else {
          console.log(finalResponse);
        }
      }

      process.exit(0);
    } catch (error: any) {
      console.error("❌ Error:", error.message);
      if (options.debug) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program
  .command("banner")
  .description("Preview the startup banner and terminal capabilities")
  .action(() => {
    const BannerPreview = React.lazy(async () => ({
      default: (await import("./ui/components/Banner")).Banner,
    }));
    render(
      <React.Suspense fallback={null}>
        <BannerPreview disable={false} />
      </React.Suspense>
    );
  });

if (!process.argv.slice(2).length) {
  program.parse(["node", "cloudeval", "chat", ...process.argv.slice(2)]);
} else {
  program.parse(process.argv);
}
