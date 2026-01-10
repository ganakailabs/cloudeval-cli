import React, { useEffect, useMemo, useState, startTransition } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Banner } from "./components/Banner.js";
import { Loader } from "./components/Loader.js";
import { Transcript } from "./components/Transcript.js";
import { InputBox } from "./components/InputBox.js";
import { Spinner } from "./components/Spinner.js";
import { Scrollbar } from "./components/Scrollbar.js";
import { ProjectSelector } from "./components/ProjectSelector.js";
import {
  initialChatState,
  reduceChunk,
  streamChat,
  getAuthToken,
  checkUserStatus,
  getProjects,
  type Project,
} from "@cloudeval/core";
import { ChatMessage, ChatState, Chunk } from "@cloudeval/shared";
import { Onboarding } from "./components/Onboarding";

export interface AppProps {
  baseUrl: string;
  apiKey?: string;
  conversationId?: string;
  model?: string;
  debug?: boolean;
  disableBanner?: boolean;
  disableAnim?: boolean;
  skipHealthCheck?: boolean;
}

const bootSteps = [
  "Loading config",
  "Validating auth",
  "Checking backend health",
  "Ready",
];

const defaultUser = { id: "cli-user", name: "CLI User" };

// Extract userName from token
const getUserNameFromToken = async (token?: string): Promise<string> => {
  if (!token) return "You";
  try {
    // Import extractEmailFromToken dynamically to avoid circular deps
    const { extractEmailFromToken } = await import("@cloudeval/core");
    const email = extractEmailFromToken(token);
    if (email) {
      // Extract name from email (part before @) or use email as name
      const namePart = email.split("@")[0];
      // Capitalize first letter
      return namePart.charAt(0).toUpperCase() + namePart.slice(1) || "You";
    }
  } catch {
    // Fallback to default
  }
  return "You";
};
const defaultProject: ProjectInfo = {
  id: "cli-project",
  name: "CLI Project",
  user_id: "cli-user",
  cloud_provider: "azure",
};

// Use Project type from core (matches frontend)
type ProjectInfo = Project;

const loadProjects = (): ProjectInfo[] => {
  const configPath = path.join(
    os.homedir(),
    ".config",
    "cloudeval",
    "projects.json"
  );
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as ProjectInfo[];
    }
    if (Array.isArray(parsed?.projects)) {
      return parsed.projects as ProjectInfo[];
    }
  } catch {
    // ignore
  }
  return [defaultProject];
};

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

export const App: React.FC<AppProps> = ({
  baseUrl,
  apiKey,
  conversationId,
  model,
  debug = false,
  disableBanner = false,
  disableAnim = false,
  skipHealthCheck = false,
}) => {
  const { exit } = useApp();
  const [phase, setPhase] = useState<"boot" | "ready" | "error">("boot");
  const [loaderStep, setLoaderStep] = useState(0);
  const [bootError, setBootError] = useState<string | undefined>();
  const [input, setInput] = useState("");
  const [authToken, setAuthToken] = useState<string | undefined>(apiKey);
  const [chatState, setChatState] = useState<ChatState>({
    ...initialChatState,
    status: "booting",
    threadId: conversationId,
    debug,
  });
  const [controller, setController] = useState<AbortController | null>(null);
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(null);
  const [selectingProject, setSelectingProject] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [checkingOnboarding, setCheckingOnboarding] = useState(false);
  const [userName, setUserName] = useState<string>("You");
  const [scrollOffset, setScrollOffset] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(20);
  const scrollViewRef = React.useRef<ScrollViewRef>(null);
  const contentHeightRef = React.useRef(0);
  const heightUpdateTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  // Ref to accumulate streaming content and reduce state updates
  const streamingContentRef = React.useRef<string>("");
  const streamingUpdateTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      setSpinnerIdx((i) => (i + 1) % spinnerFrames.length);
    }, 100);
    return () => clearInterval(id);
  }, []);

  // Cleanup height update timeout on unmount
  useEffect(() => {
    return () => {
      if (heightUpdateTimeoutRef.current) {
        clearTimeout(heightUpdateTimeoutRef.current);
      }
    };
  }, []);

  const checkHealth = useMemo(() => {
    return async (token?: string) => {
      try {
        const headers: Record<string, string> = {};
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
        const healthUrl = new URL("/chat/health", baseUrl).toString();
        const res = await fetch(healthUrl, {
          method: "GET",
          headers,
        });
        
        if (!res.ok) {
          console.warn(`Health check failed: ${res.status} ${res.statusText} at ${healthUrl}`);
          return false;
        }
        
        const json = await res.json();
        return json?.status === "healthy" || json?.status === "ok";
      } catch (error: any) {
        console.warn(`Health check error: ${error.message || error} at ${baseUrl}/chat/health`);
        return false;
      }
    };
  }, [baseUrl]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setChatState((prev) => ({ ...prev, status: "booting" }));
      // Step 0: load config
      setLoaderStep(0);
      await delay(150);
      if (cancelled) return;

      // Step 1: validate auth / fetch token
      setLoaderStep(1);
      let token: string | undefined = authToken ?? apiKey;
      if (!token) {
        try {
          token = await getAuthToken({ apiKey });
          if (cancelled) return;
          setAuthToken(token);
        } catch (error: any) {
          // If no API key and no stored token, automatically trigger login
          if (!apiKey && error?.message?.includes("No authentication available")) {
            setIsLoggingIn(true);
            setLoaderStep(1);
            try {
              const { loginWithDeviceCode } = await import("@cloudeval/core");
              const newToken = await loginWithDeviceCode();
              if (cancelled) return;
              setAuthToken(newToken);
              setIsLoggingIn(false);
              token = newToken;
            } catch (loginError: any) {
              setIsLoggingIn(false);
              setBootError(loginError?.message ?? "Login failed");
              setPhase("error");
              return;
            }
          } else {
            setBootError(error?.message ?? "Authentication failed");
            setPhase("error");
            return;
          }
        }
      }

      if (token && token !== authToken) {
        setAuthToken(token);
      }

      // Extract userName from token
      if (token && !apiKey) {
        getUserNameFromToken(token).then(setUserName).catch(() => {
          // Fallback to default if extraction fails
          setUserName("You");
        });
      }

      // Step 1.5: Check onboarding status and fetch projects (only if not using API key)
      if (!apiKey && token) {
        setCheckingOnboarding(true);
        try {
          const userStatus = await checkUserStatus(baseUrl, token);
          if (!userStatus.onboardingCompleted) {
            setNeedsOnboarding(true);
            setPhase("ready"); // Show onboarding UI
            setCheckingOnboarding(false);
            return;
          }
          
          // Fetch projects after onboarding check
          if (userStatus.user?.id) {
            setLoadingProjects(true);
            const fetchedProjects = await getProjects(baseUrl, token, userStatus.user.id);
            setLoadingProjects(false);
            
            if (fetchedProjects.length > 0) {
              setProjects(fetchedProjects);
              
              // Auto-select playground project (name === "Playground")
              const playgroundProject = fetchedProjects.find(
                (p: ProjectInfo) => p.name === "Playground"
              );
              
              if (playgroundProject) {
                setSelectedProject(playgroundProject);
                setSelectingProject(false);
              } else if (fetchedProjects.length === 1) {
                // If only one project, auto-select it
                setSelectedProject(fetchedProjects[0]);
                setSelectingProject(false);
              } else {
                // Multiple projects, show selector
                setSelectingProject(true);
              }
            } else {
              // No projects, use default
              setSelectedProject(defaultProject);
              setSelectingProject(false);
            }
          }
        } catch (error) {
          // If check fails, continue anyway (backward compat)
          console.warn("Onboarding/projects check failed, continuing:", error);
          setSelectedProject(defaultProject);
          setSelectingProject(false);
        }
        setCheckingOnboarding(false);
        setLoadingProjects(false);
      } else {
        // Using API key, use default project
        setSelectedProject(defaultProject);
        setSelectingProject(false);
      }

      // Step 2: health check with token (unless skipped)
      setLoaderStep(2);
      if (!skipHealthCheck) {
        const healthy = await checkHealth(token);
        if (!healthy) {
          setBootError(
            `Backend health check failed. Is the backend running at ${baseUrl}? Use --no-health-check to skip.`
          );
          setPhase("error");
          return;
        }
      }

      // Step 3: ready
      setLoaderStep(3);
      await delay(100);
      if (cancelled) return;
      setPhase("ready");
      setChatState((prev) => ({ ...prev, status: "idle" }));
    };
    run();
    return () => {
      cancelled = true;
      controller?.abort();
    };
  }, [checkHealth, disableAnim, controller, baseUrl, authToken, apiKey, skipHealthCheck]);

  const appendUserMessage = (content: string): ChatMessage => {
    const message: ChatMessage = {
      id: randomUUID(),
      role: "user",
      content,
      createdAt: Date.now(),
    };
    setChatState((prev) => ({
      ...prev,
      messages: [...prev.messages, message],
    }));
    return message;
  };

  const sendMessage = async (text: string) => {
    if (!text.trim()) return;

    if (controller) {
      controller.abort("Starting new message");
    }

    let token = authToken ?? apiKey;
    if (!token) {
      try {
        token = await getAuthToken({ apiKey });
        setAuthToken(token);
      } catch (error: any) {
        setChatState((prev) => ({
          ...prev,
          status: "error",
          error: error?.message ?? "Authentication failed",
        }));
        return;
      }
    }

    const threadId = chatState.threadId ?? randomUUID();
    setChatState((prev) => ({
      ...prev,
      threadId,
      status: "connecting",
      activeMessageId: undefined,
      followUpScratch: undefined,
      messages: prev.messages.map((m) =>
        m.role === "assistant" && m.pending ? { ...m, pending: false } : m
      ),
    }));

    appendUserMessage(text);

    const ctrl = new AbortController();
    setController(ctrl);

    try {
      // Use requestAnimationFrame to batch updates and prevent line breaks
      let pendingChunks: Chunk[] = [];
      let rafId: number | null = null;
      let lastUpdateTime = Date.now();
      
      const flushChunks = () => {
        if (pendingChunks.length === 0) {
          rafId = null;
          return;
        }
        
        const chunksToProcess = [...pendingChunks];
        pendingChunks = [];
        rafId = null;
        lastUpdateTime = Date.now();
        
        // Use startTransition to defer state updates and prevent blocking renders
        startTransition(() => {
          setChatState((prev) => {
            let state = prev;
            for (const chunk of chunksToProcess) {
              state = reduceChunk(state, chunk);
            }
            return state;
          });
        });
      };
      
      const scheduleFlush = () => {
        if (rafId !== null) return;
        
        // CRITICAL: Batch updates very aggressively to prevent line breaks
        // Update every 500ms or when we have 20+ chunks, whichever comes first
        // Much longer interval = much fewer re-renders = no new lines in terminal
        const timeSinceLastUpdate = Date.now() - lastUpdateTime;
        const minInterval = 500; // 500ms = 2fps - minimizes re-renders
        
        if (timeSinceLastUpdate >= minInterval || pendingChunks.length >= 20) {
          flushChunks();
        } else {
          rafId = setTimeout(flushChunks, minInterval - timeSinceLastUpdate) as unknown as number;
        }
      };
      
      for await (const chunk of streamChat({
        baseUrl,
        authToken: token,
        message: text,
        threadId,
        user: defaultUser,
        project: selectedProject || defaultProject,
        settings: model ? { model } : undefined,
        signal: ctrl.signal,
        debug,
      })) {
        pendingChunks.push(chunk);
        scheduleFlush();
      }
      
      // Flush any remaining chunks immediately
      if (rafId !== null) {
        clearTimeout(rafId);
      }
      flushChunks();
      
      setChatState((prev) => ({
        ...prev,
        status: prev.status === "error" ? prev.status : "complete",
      }));
    } catch (error: any) {
      setChatState((prev) => ({
        ...prev,
        status: "error",
        error: error?.message ?? "Streaming failed",
      }));
    } finally {
      setController(null);
    }
  };

  useInput(
    (inputKey, key) => {
      // Scroll controls - use Ctrl+Arrow to work even when input is focused
      // Also support Page Up/Down and Ctrl+H/E for top/bottom
      if (phase === "ready") {
        // Ctrl+Arrow keys work even when input is focused
        if (key.ctrl && key.upArrow) {
          scrollViewRef.current?.scrollBy(-1);
          return;
        }
        if (key.ctrl && key.downArrow) {
          scrollViewRef.current?.scrollBy(1);
          return;
        }
        // Arrow keys without Ctrl (only work when input is not focused)
        if (key.upArrow && !key.ctrl && !key.meta && !key.shift) {
          scrollViewRef.current?.scrollBy(-1);
          return;
        }
        if (key.downArrow && !key.ctrl && !key.meta && !key.shift) {
          scrollViewRef.current?.scrollBy(1);
          return;
        }
        // Page Up/Down
        if (key.pageUp && !key.ctrl && !key.meta) {
          scrollViewRef.current?.scrollBy(-Math.max(1, Math.floor(viewportHeight * 0.8)));
          return;
        }
        if (key.pageDown && !key.ctrl && !key.meta) {
          scrollViewRef.current?.scrollBy(Math.max(1, Math.floor(viewportHeight * 0.8)));
          return;
        }
        // Scroll to top/bottom with Ctrl+H (home) and Ctrl+E (end)
        if (key.ctrl && inputKey.toLowerCase() === "h" && inputKey.toLowerCase() !== "l") {
          scrollViewRef.current?.scrollToTop();
          return;
        }
        if (key.ctrl && inputKey.toLowerCase() === "e") {
          scrollViewRef.current?.scrollToBottom();
          return;
        }
      }

      // Other controls
      if (key.escape && controller) {
        controller.abort("Cancelled by user");
        setChatState((prev) => ({ ...prev, status: "canceled" }));
      }
      if (key.ctrl && inputKey.toLowerCase() === "l") {
        setChatState((prev) => ({
          ...initialChatState,
          status: "idle",
          threadId: undefined,
          messages: [],
        }));
        // Reset scroll to top when clearing
        setTimeout(() => scrollViewRef.current?.scrollToTop(), 0);
      }
      if (inputKey.toLowerCase() === "q" && key.ctrl) {
        exit();
      }
    },
    { isActive: phase === "ready" }
  );

  if (phase === "boot") {
    return (
      <Box flexDirection="column" padding={1}>
        <Banner disable={disableBanner || !!process.env.CLOUDEVAL_NO_BANNER} />
        {isLoggingIn ? (
          <Box flexDirection="column" gap={1} padding={1}>
            <Text color="cyan" bold>🔐 Logging in...</Text>
            <Text dimColor>Please complete authentication in your browser.</Text>
          </Box>
        ) : (
          <Loader
            step={loaderStep}
            steps={bootSteps}
            animate={!disableAnim && !process.env.CLOUDEVAL_NO_ANIM}
          />
        )}
      </Box>
    );
  }

  // Show onboarding if needed
  if (needsOnboarding && phase === "ready" && authToken) {
    return (
      <Onboarding
        baseUrl={baseUrl}
        token={authToken}
        onComplete={() => {
          setNeedsOnboarding(false);
          setChatState((prev) => ({ ...prev, status: "idle" }));
        }}
      />
    );
  }

  if (phase === "error") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Failed to start CLI.</Text>
        <Text>{bootError ?? "Unknown error"}</Text>
        <Text>
          Base URL: {baseUrl} (set via CLOUDEVAL_BASE_URL or --base-url)
        </Text>
        <Text>Press Ctrl+C to quit.</Text>
      </Box>
    );
  }

  if (selectingProject) {
    const items = projects.map((p) => ({
      label: `${p.name} (${p.cloud_provider ?? "cloud"})${p.name === "Playground" ? " [Playground]" : ""}`,
      value: p.id,
    }));
    return (
      <Box flexDirection="column" padding={1} gap={1}>
        <Banner disable={disableBanner || !!process.env.CLOUDEVAL_NO_BANNER} />
        <Text>Select a project to chat with:</Text>
        {loadingProjects ? (
          <Text>Loading projects...</Text>
        ) : (
          <ProjectSelector
            items={items}
            onSubmit={(selected) => {
              const id = selected[0] as string | undefined;
              const choice = projects.find((p) => p.id === id) ?? projects[0];
              setSelectedProject(choice || defaultProject);
              setSelectingProject(false);
            }}
            limit={Math.max(5, items.length)}
          />
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Banner disable={disableBanner || !!process.env.CLOUDEVAL_NO_BANNER} />
      {(() => {
        const latestAssistant = [...chatState.messages]
          .reverse()
          .find((m) => m.role === "assistant");
        const streamingSteps =
          latestAssistant?.thinkingSteps?.filter(
            (s) => (s.status ?? "streaming") === "streaming"
          ) ?? [];

        const statusText = (() => {
          if (chatState.status === "thinking" && streamingSteps.length) {
            return "Thinking...";
          }
          if (chatState.status === "streaming") return "Generating response";
          if (chatState.status === "complete") return "Complete";
          if (chatState.status === "error") return "Error";
          if (chatState.status === "canceled") return "Canceled";
          return "Idle";
        })();

        return (
          <Box flexDirection="column" gap={0}>
            <Box justifyContent="space-between">
              <Text>
                Model: {model ?? "auto"} | Project: {selectedProject?.name ?? defaultProject.name}
              </Text>
              <Text dimColor>Server: {baseUrl}</Text>
            </Box>
          <Text>
            Status:{" "}
            {chatState.status === "thinking" ? (
              <>
                <Spinner type="dots" /> {statusText}
              </>
            ) : (
              statusText
            )}
          </Text>
          </Box>
        );
      })()}
      <Box flexDirection="column" borderStyle="round" padding={1}>
        {/* Render messages in ScrollView so streaming appears inline with history */}
        <Box flexDirection="row">
          <Box flexGrow={1}>
            <ScrollView 
              ref={scrollViewRef}
              height={19}
              onScroll={(offset) => setScrollOffset(offset)}
              onContentHeightChange={(height) => {
                // Only update height when not streaming to prevent re-renders
                if (chatState.status !== "streaming" && chatState.status !== "thinking") {
                  setContentHeight(height);
                  const currentOffset = scrollViewRef.current?.getScrollOffset() ?? 0;
                  const maxOffset = height - viewportHeight;
                  if (currentOffset >= maxOffset - 2) {
                    setTimeout(() => scrollViewRef.current?.scrollToBottom(), 0);
                  }
                }
              }}
              onViewportSizeChange={(size) => setViewportHeight(size.height)}
            >
              <Transcript messages={chatState.messages} userName={userName} excludeStreaming={false} />
            </ScrollView>
          </Box>
          <Scrollbar
            scrollOffset={scrollOffset}
            contentHeight={contentHeight}
            viewportHeight={viewportHeight}
          />
        </Box>
      </Box>
      <Text dimColor>
        Scroll: Ctrl+↑↓ (always) · ↑↓ (when input not focused) · Page Up/Down · Ctrl+H (top) · Ctrl+E (bottom) · Ctrl+L (clear) · Ctrl+C (exit)
      </Text>
      <InputBox
        value={input}
        onChange={setInput}
        onSubmit={(val) => {
          setInput("");
          sendMessage(val);
        }}
        disabled={chatState.status === "connecting"}
      />
    </Box>
  );
};
