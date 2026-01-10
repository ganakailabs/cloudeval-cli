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
    process.env.CLOUDEVAL_BASE_URL ?? "http://localhost:8000"
  )
  .option("--api-key <key>", "API key", process.env.CLOUDEVAL_API_KEY)
  .option("--conversation <id>", "Conversation/thread id to resume")
  .option("--model <name>", "Model name")
  .option("--debug", "Log raw chunks", false)
  .option("--no-health-check", "Skip health check and start anyway")
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
        skipHealthCheck={options.healthCheck === false}
      />
    );
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
