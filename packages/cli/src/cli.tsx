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
      const fs = await import("node:fs");
      const fsPromises = await import("node:fs/promises");
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
        try {
          token = await getAuthToken({ apiKey: options.apiKey, baseUrl: options.baseUrl });
        } catch (error: any) {
          // If no API key and no stored token, automatically trigger login
          if (!options.apiKey && error?.message?.includes("No authentication available")) {
            console.log("🔐 Authentication required. Starting login process...\n");
            try {
              const { loginWithDeviceCode } = await import("@cloudeval/core");
              token = await loginWithDeviceCode();
              console.log("\n✅ Authentication successful! Proceeding with your question...\n");
            } catch (loginError: any) {
              console.error(`❌ Login failed: ${loginError.message}`);
              process.exit(1);
            }
          } else {
            console.error(`❌ Authentication failed: ${error.message}`);
            process.exit(1);
          }
        }
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
      let outputStream: NodeJS.WritableStream;

      if (options.debug) {
        console.error(`[ask] Question: ${question}`);
        console.error(`[ask] Project: ${project.id} (${project.name})`);
        console.error(`[ask] Thread ID: ${threadId}`);
      }

      // Set up output stream
      if (options.output) {
        outputStream = fs.createWriteStream(options.output, { encoding: "utf-8" });
      } else {
        outputStream = process.stdout;
      }

      // Disable thinking steps display for ask command (non-interactive, causes visual clutter)
      // For interactive chat, thinking steps are shown in the UI, but for ask we just stream content
      let spinnerInterval: NodeJS.Timeout | null = null;

      try {
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

          // Get the latest assistant message
          const latestMessage = [...chatState.messages]
            .reverse()
            .find((m) => m.role === "assistant");

          // Stream responding chunks in real-time (for non-JSON mode)
          // chunk.content is incremental (just the new part), so output it directly
          if (!options.json && chunk.type === "responding" && chunk.content) {
            // Output the incremental content directly
            outputStream.write(chunk.content);
            // Track cumulative content for final output
            if (latestMessage?.content) {
              responseText = latestMessage.content;
            }
          }

          // Handle errors
          if (chunk.type === "error") {
            const errorMsg = chunk.message || chunk.description || "Unknown error";
            if (options.json) {
              // For JSON mode, we'll include error in final output
              responseText = `Error: ${errorMsg}`;
            } else {
              // For streaming mode, output error immediately
              outputStream.write(`\n❌ Error: ${errorMsg}\n`);
            }
            break;
          }
        }

        // Cleanup (no thinking steps for ask command)

        // Ensure we output everything (in case we missed some content)
        if (!options.json) {
          // Add newline at the end for non-JSON output
          outputStream.write("\n");
          
          if (options.output) {
            outputStream.end();
          }
        }
      } catch (error: any) {
        const errorMsg = error.message || "Streaming failed";
        if (options.json) {
          responseText = `Error: ${errorMsg}`;
        } else {
          outputStream.write(`\n❌ Error: ${errorMsg}\n`);
        }
        if (options.output) {
          outputStream.end();
        }
        throw error;
      }

      // For JSON mode, output the complete response as JSON
      if (options.json) {
        const finalMessage = [...chatState.messages]
          .reverse()
          .find((m) => m.role === "assistant");
        
        const finalResponse = finalMessage?.content || responseText || "";
        const output = {
          question,
          response: finalResponse,
          threadId: chatState.threadId,
          project: {
            id: project.id,
            name: project.name,
          },
        };
        const outputText = JSON.stringify(output, null, 2) + "\n";
        
        if (options.output) {
          await fsPromises.writeFile(options.output, outputText, "utf-8");
        } else {
          process.stdout.write(outputText);
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
