import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { completeOnboarding } from "@cloudeval/core";

interface OnboardingProps {
  baseUrl: string;
  token: string;
  onComplete: () => void;
}

const ROLES = [
  "Developer",
  "DevOps Engineer",
  "Cloud Architect",
  "Platform Engineer",
  "SRE",
  "Other",
];

const TEAM_SIZES = ["1", "2-5", "6-10", "11-50", "51-200", "200+"];

const GOALS = [
  "Infrastructure as Code",
  "Cloud Migration",
  "Cost Optimization",
  "Security & Compliance",
  "Automation",
  "Multi-cloud Strategy",
];

const CLOUD_PROVIDERS = ["Azure", "AWS", "GCP", "Multi-cloud", "Other"];

export const Onboarding: React.FC<OnboardingProps> = ({
  baseUrl,
  token,
  onComplete,
}) => {
  const [step, setStep] = useState(0);
  const [data, setData] = useState({
    name: "",
    role: "",
    teamSize: "",
    goals: [] as string[],
    cloudProvider: "",
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useInput((input, key) => {
    if (submitting) return;

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      if (step === 3) {
        // Goals step - can select multiple
        setSelectedIndex((i) => Math.min(GOALS.length - 1, i + 1));
      } else if (step === 1) {
        setSelectedIndex((i) => Math.min(ROLES.length - 1, i + 1));
      } else if (step === 2) {
        setSelectedIndex((i) => Math.min(TEAM_SIZES.length - 1, i + 1));
      } else if (step === 4) {
        setSelectedIndex((i) => Math.min(CLOUD_PROVIDERS.length - 1, i + 1));
      }
    } else if (input === " " && step === 3) {
      // Toggle goal selection
      const goal = GOALS[selectedIndex];
      setData((prev) => ({
        ...prev,
        goals: prev.goals.includes(goal)
          ? prev.goals.filter((g) => g !== goal)
          : [...prev.goals, goal],
      }));
    } else if (key.return) {
      if (step === 0) {
        // Name input
        if (data.name.trim()) {
          setStep(1);
          setSelectedIndex(0);
        }
      } else if (step === 1) {
        // Role selection
        setData((prev) => ({ ...prev, role: ROLES[selectedIndex] }));
        setStep(2);
        setSelectedIndex(0);
      } else if (step === 2) {
        // Team size
        setData((prev) => ({ ...prev, teamSize: TEAM_SIZES[selectedIndex] }));
        setStep(3);
        setSelectedIndex(0);
      } else if (step === 3) {
        // Goals (can continue with at least one)
        if (data.goals.length > 0) {
          setStep(4);
          setSelectedIndex(0);
        }
      } else if (step === 4) {
        // Cloud provider
        setData((prev) => ({
          ...prev,
          cloudProvider: CLOUD_PROVIDERS[selectedIndex],
        }));
        handleSubmit();
      }
    } else if (key.backspace && step === 0) {
      setData((prev) => ({ ...prev, name: prev.name.slice(0, -1) }));
    } else if (step === 0 && input.length === 1 && !key.ctrl && !key.meta) {
      setData((prev) => ({ ...prev, name: prev.name + input }));
    }
  });

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);

    try {
      await completeOnboarding(baseUrl, token, {
        name: data.name,
        role: data.role,
        teamSize: data.teamSize,
        goals: data.goals,
        cloudProvider: data.cloudProvider,
      });
      onComplete();
    } catch (err: any) {
      setError(err.message || "Failed to complete onboarding");
      setSubmitting(false);
    }
  };

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      <Text bold color="cyan">
        Welcome to Cloudeval CLI! Let's get you set up.
      </Text>
      <Text dimColor>Step {step + 1} of 5</Text>

      {step === 0 && (
        <Box flexDirection="column" gap={1}>
          <Text>What's your name?</Text>
          <Text>
            <Text color="green">{data.name}</Text>
            <Text color="yellow">▌</Text>
          </Text>
          <Text dimColor>Type your name and press Enter</Text>
        </Box>
      )}

      {step === 1 && (
        <Box flexDirection="column" gap={1}>
          <Text>What's your role?</Text>
          {ROLES.map((role, idx) => (
            <Text key={role} color={idx === selectedIndex ? "cyan" : undefined}>
              {idx === selectedIndex ? "> " : "  "}
              {role}
            </Text>
          ))}
          <Text dimColor>Use ↑↓ to navigate, Enter to select</Text>
        </Box>
      )}

      {step === 2 && (
        <Box flexDirection="column" gap={1}>
          <Text>What's your team size?</Text>
          {TEAM_SIZES.map((size, idx) => (
            <Text key={size} color={idx === selectedIndex ? "cyan" : undefined}>
              {idx === selectedIndex ? "> " : "  "}
              {size}
            </Text>
          ))}
          <Text dimColor>Use ↑↓ to navigate, Enter to select</Text>
        </Box>
      )}

      {step === 3 && (
        <Box flexDirection="column" gap={1}>
          <Text>What are your goals? (Select multiple with Space)</Text>
          {GOALS.map((goal, idx) => (
            <Text key={goal} color={idx === selectedIndex ? "cyan" : undefined}>
              {data.goals.includes(goal) ? "✓ " : "  "}
              {idx === selectedIndex ? "> " : "  "}
              {goal}
            </Text>
          ))}
          <Text dimColor>
            Selected: {data.goals.length} goal(s). Press Enter to continue.
          </Text>
        </Box>
      )}

      {step === 4 && (
        <Box flexDirection="column" gap={1}>
          <Text>Which cloud provider do you use?</Text>
          {CLOUD_PROVIDERS.map((provider, idx) => (
            <Text
              key={provider}
              color={idx === selectedIndex ? "cyan" : undefined}
            >
              {idx === selectedIndex ? "> " : "  "}
              {provider}
            </Text>
          ))}
          <Text dimColor>Use ↑↓ to navigate, Enter to select</Text>
        </Box>
      )}

      {error && <Text color="red">Error: {error}</Text>}
      {submitting && <Text color="yellow">Completing onboarding...</Text>}
    </Box>
  );
};
