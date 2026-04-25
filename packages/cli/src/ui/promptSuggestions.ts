type ChatMode = "ask" | "agent";
type StarterVariant = "homepage" | "template" | "live";
type CloudProvider = "azure" | "aws" | "gcp" | "digitalocean" | "custom";

export interface StarterProjectContext {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  cloud_provider?: string | null;
}

export interface PromptMessageContext {
  role?: string;
}

export interface StarterPromptOptions {
  mode: ChatMode;
  project?: StarterProjectContext | null;
  limit?: number;
}

export interface PromptSuggestionOptions extends StarterPromptOptions {
  latestFollowUps: string[];
  messages: PromptMessageContext[];
}

export type PromptSuggestionKind = "followup" | "starter" | "none";

export interface PromptSuggestions {
  kind: PromptSuggestionKind;
  label: string;
  prompts: string[];
}

interface PromptGroup {
  base: string[];
  modes: Record<ChatMode, string[]>;
  providers: Record<CloudProvider, string[]>;
}

const promptGroups: Record<StarterVariant, PromptGroup> = {
  homepage: {
    base: [
      "Review this template for risks",
      "Map resources and dependencies",
      "Find cost optimization opportunities",
      "Explain security and compliance gaps",
      "Compare architecture against best practices",
      "Summarize deployment readiness",
      "Generate implementation tasks",
      "Identify missing observability controls",
      "Explain resources in plain English",
      "Create a remediation checklist",
    ],
    modes: {
      ask: [
        "Explain what CloudEval can analyze",
        "Summarize available infrastructure insights",
        "Show example cloud review questions",
        "Explain project setup requirements",
      ],
      agent: [
        "Create a cloud project",
        "Set up a cloud connection",
        "Run cost and architecture evaluations",
        "Generate tasks from findings",
        "Prepare an execution plan",
      ],
    },
    providers: {
      azure: [
        "Check Azure Well-Architected gaps",
        "Review Azure Policy coverage",
        "Explain Azure resource dependencies",
        "Find Azure cost anomalies",
      ],
      aws: [
        "Check AWS Well-Architected gaps",
        "Review IAM and network risks",
        "Explain AWS resource dependencies",
        "Find AWS cost anomalies",
      ],
      gcp: [
        "Check Google Cloud architecture gaps",
        "Review IAM and firewall risks",
        "Explain GCP resource dependencies",
        "Find GCP cost anomalies",
      ],
      digitalocean: [
        "Review Droplet sizing and exposure",
        "Map DigitalOcean resource dependencies",
        "Find DigitalOcean cost anomalies",
        "Check firewall and access risks",
      ],
      custom: [
        "Identify provider-specific risks",
        "Map custom resource dependencies",
        "Review custom deployment readiness",
        "Find custom cost anomalies",
      ],
    },
  },
  template: {
    base: [
      "Which resources does this template create",
      "Explain template parameters and outputs",
      "Find deployment blockers in this template",
      "Review template security risks",
      "Map template resource dependencies",
      "Estimate template cost drivers",
      "Compare template against best practices",
      "Suggest safer default values",
      "Generate deployment validation steps",
      "Create a template remediation plan",
      "Explain required permissions",
      "Identify missing tags and metadata",
    ],
    modes: {
      ask: [
        "Explain this template structure",
        "Summarize deployment requirements",
        "Describe security tradeoffs",
        "Compare template design alternatives",
      ],
      agent: [
        "Run template validation and fixes",
        "Create a deployment remediation plan",
        "Generate task checklist from risks",
        "Prepare connection setup steps",
        "Run architecture review on template",
      ],
    },
    providers: {
      azure: [
        "Validate ARM or Bicep structure",
        "Check Azure Policy alignment",
        "Review managed identity usage",
        "Find risky Azure defaults",
      ],
      aws: [
        "Validate CloudFormation structure",
        "Review IAM policy scope",
        "Check VPC and security groups",
        "Find risky AWS defaults",
      ],
      gcp: [
        "Validate Deployment Manager structure",
        "Review service account permissions",
        "Check firewall rule exposure",
        "Find risky GCP defaults",
      ],
      digitalocean: [
        "Review Droplet and firewall defaults",
        "Check DigitalOcean token permissions",
        "Validate resource dependency order",
        "Find risky DigitalOcean defaults",
      ],
      custom: [
        "Validate custom template structure",
        "Review custom permission requirements",
        "Check provider-specific defaults",
        "Find risky custom assumptions",
      ],
    },
  },
  live: {
    base: [
      "Show currently deployed resources",
      "Find unused or idle resources",
      "Analyze cost trends by service",
      "Review critical security findings",
      "Map live resource dependencies",
      "Summarize health and sync status",
      "Prioritize remediation by impact",
      "Create an action plan",
      "Find reliability risks",
      "Review monitoring coverage",
      "Explain recent cost changes",
      "Identify public exposure risks",
    ],
    modes: {
      ask: [
        "Explain current infrastructure health",
        "Summarize top risks and costs",
        "Show affected resources",
        "Describe dependency impact",
      ],
      agent: [
        "Run Well-Architected Framework evaluation",
        "Run cost evaluation report",
        "Create remediation tasks from findings of architecture and cost reports",
        "Investigate critical issues with tools",
        "Refresh sync and summarize drift of the environment",
        "Build execution plan for owners to fix the issues",
      ],
    },
    providers: {
      azure: [
        "Review Azure Advisor findings",
        "Check subscription security posture",
        "Analyze Azure cost by SKU",
        "Map Azure networking dependencies",
      ],
      aws: [
        "Review AWS Trusted Advisor gaps",
        "Check account security posture",
        "Analyze AWS cost by service",
        "Map AWS networking dependencies",
      ],
      gcp: [
        "Review Security Command Center gaps",
        "Check project security posture",
        "Analyze GCP cost by service",
        "Map GCP networking dependencies",
      ],
      digitalocean: [
        "Review Droplet health and sizing",
        "Check firewall and project exposure",
        "Analyze DigitalOcean cost by service",
        "Map DigitalOcean networking dependencies",
      ],
      custom: [
        "Review connected resource health",
        "Check custom security posture",
        "Analyze custom cost drivers",
        "Map custom networking dependencies",
      ],
    },
  },
};

const normalizeProvider = (value: string | null | undefined): CloudProvider | null => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (
    normalized === "azure" ||
    normalized === "aws" ||
    normalized === "gcp" ||
    normalized === "digitalocean" ||
    normalized === "custom"
  ) {
    return normalized;
  }
  return null;
};

const starterVariantForProject = (
  project: StarterProjectContext | null | undefined
): StarterVariant => {
  if (!project) {
    return "homepage";
  }
  return project.type === "template" ? "template" : "live";
};

const dedupePrompts = (prompts: string[]): string[] =>
  Array.from(new Set(prompts.map((prompt) => prompt.trim()).filter(Boolean)));

const hasEightWordsOrLess = (prompt: string): boolean =>
  prompt.split(/\s+/).filter(Boolean).length <= 8;

const hashString = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const stableShuffle = (prompts: string[], seed: string): string[] =>
  prompts
    .map((prompt, index) => ({
      prompt,
      rank: hashString(`${seed}:${prompt}:${index}`),
    }))
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.prompt);

export const getStarterPrompts = ({
  mode,
  project,
  limit = 4,
}: StarterPromptOptions): string[] => {
  const variant = starterVariantForProject(project);
  const provider = normalizeProvider(project?.cloud_provider);
  const group = promptGroups[variant];
  const seed = `${variant}:${mode}:${provider ?? "any"}:${project?.id ?? project?.type ?? ""}`;
  const prompts = [
    ...stableShuffle(group.modes[mode] ?? [], `${seed}:mode`),
    ...(provider ? stableShuffle(group.providers[provider] ?? [], `${seed}:provider`) : []),
    ...stableShuffle(group.base, `${seed}:base`),
  ];

  return dedupePrompts(prompts).filter(hasEightWordsOrLess).slice(0, limit);
};

export const getPromptSuggestions = ({
  latestFollowUps,
  messages,
  mode,
  project,
  limit,
}: PromptSuggestionOptions): PromptSuggestions => {
  const followUps = latestFollowUps.map((prompt) => prompt.trim()).filter(Boolean);
  if (followUps.length) {
    return {
      kind: "followup",
      label: "Follow-ups",
      prompts: followUps,
    };
  }

  const hasUserMessages = messages.some((message) => message.role === "user");
  if (!hasUserMessages) {
    return {
      kind: "starter",
      label: "Starters",
      prompts: getStarterPrompts({ mode, project, limit }),
    };
  }

  return {
    kind: "none",
    label: "Follow-ups",
    prompts: [],
  };
};
