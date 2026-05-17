import type { AgentProfile } from "./types";

const baseSettings = {
  mode: "agent" as const,
  response_length: "Detailed",
  technicality: "Expert",
  reasoning_effort: "medium",
  enable_judge: true,
  enable_hitl: true,
};

export const BUNDLED_AGENT_PROFILES: AgentProfile[] = [
  {
    id: "architecture",
    display_name: "Architecture",
    description:
      "Reviews topology, dependencies, blast radius, reliability, security, cost, operational excellence, and performance signals.",
    personality: "Systems-minded, concise, and dependency-aware.",
    accent_key: "blue",
    icon_key: "network",
    default_mode: "agent",
    starter_prompt:
      "Review this project architecture for the highest-impact risks and next actions.",
    starter_prompts: {
      template:
        "Review this template architecture for topology, dependency, and platform-design risks.",
      sync:
        "Review this live environment architecture for topology, dependency, and blast-radius risks.",
    },
    starter_prompt_variants: [
      {
        id: "architecture-template-agent",
        project_source: "template",
        mode: "agent",
        text: "Review this template architecture for topology, dependency, and platform-design risks.",
        weight: 1,
      },
      {
        id: "architecture-sync-agent",
        project_source: "sync",
        mode: "agent",
        text: "Review this live environment architecture for topology, dependency, and blast-radius risks.",
        weight: 1,
      },
    ],
    system_instructions:
      "Use the Architecture lens. Prioritize topology, dependencies, blast radius, reliability, security, cost, operations, and performance evidence. Return risk-ranked findings with concrete validation steps.",
    default_settings: { ...baseSettings },
    required_capabilities: ["projects:read", "reports:read", "ask:run"],
    allowed_toolsets: ["projects", "reports", "graph", "rules"],
    output_contract: {
      sections: ["interpretation", "top_signals", "actions", "checkpoint"],
    },
  },
  {
    id: "cost",
    display_name: "Cost",
    description:
      "Reviews project cost drivers, waste signals, and practical optimization opportunities.",
    personality: "Commercially pragmatic, specific, and action-oriented.",
    accent_key: "emerald",
    icon_key: "wallet",
    default_mode: "agent",
    starter_prompt:
      "Review this project for cost drivers, waste signals, and practical savings actions.",
    starter_prompts: {
      template:
        "Review this template for cost drivers, expensive defaults, and safer sizing choices.",
      sync:
        "Review this live environment for waste signals, savings opportunities, and ownership gaps.",
    },
    starter_prompt_variants: [
      {
        id: "cost-template-agent",
        project_source: "template",
        mode: "agent",
        text: "Review this template for cost drivers, expensive defaults, and safer sizing choices.",
        weight: 1,
      },
      {
        id: "cost-sync-agent",
        project_source: "sync",
        mode: "agent",
        text: "Review this live environment for waste signals, savings opportunities, and ownership gaps.",
        weight: 1,
      },
    ],
    system_instructions:
      "Use the Cost lens. Prioritize spend drivers, over-provisioning, idle or low-value resources, tagging gaps, pricing model choices, and savings actions. Keep recommendations commercially practical.",
    default_settings: { ...baseSettings },
    required_capabilities: [
      "projects:read",
      "reports:read",
      "billing:read",
      "ask:run",
    ],
    allowed_toolsets: ["projects", "reports", "billing", "cost"],
    output_contract: {
      sections: ["cost_drivers", "waste_signals", "savings_actions", "checkpoint"],
    },
  },
  {
    id: "triage",
    display_name: "Triage",
    description:
      "Helps investigate likely failure domains, affected resources, and first response actions.",
    personality: "Calm, diagnostic, and time-sensitive.",
    accent_key: "orange",
    icon_key: "activity",
    default_mode: "agent",
    starter_prompt:
      "Triage this project for likely failure domains, impact paths, and first checks.",
    starter_prompts: {
      template:
        "Triage this template for likely deployment failure domains and first checks.",
      sync:
        "Triage this live environment for likely failure domains, impacted paths, and containment checks.",
    },
    starter_prompt_variants: [
      {
        id: "triage-template-agent",
        project_source: "template",
        mode: "agent",
        text: "Triage this template for likely deployment failure domains and first checks.",
        weight: 1,
      },
      {
        id: "triage-sync-agent",
        project_source: "sync",
        mode: "agent",
        text: "Triage this live environment for likely failure domains, impacted paths, and containment checks.",
        weight: 1,
      },
    ],
    system_instructions:
      "Use the Triage lens. Prioritize failure domains, affected resources, impact paths, first checks, rollback or containment options, and uncertainty that needs quick validation.",
    default_settings: { ...baseSettings },
    required_capabilities: ["projects:read", "reports:read", "ask:run"],
    allowed_toolsets: ["projects", "reports", "graph", "rules"],
    output_contract: {
      sections: ["hypothesis", "impact", "first_checks", "containment"],
    },
  },
  {
    id: "remediation",
    display_name: "Remediation",
    description:
      "Turns findings into ordered implementation steps with owners, dependencies, and validation checks.",
    personality: "Delivery-focused, practical, and sequencing-aware.",
    accent_key: "rose",
    icon_key: "list-checks",
    default_mode: "agent",
    starter_prompt:
      "Create an ordered remediation plan for this project with dependencies and validation checks.",
    starter_prompts: {
      template:
        "Create a template remediation plan with ordered changes, dependencies, and validation checks.",
      sync:
        "Create a live-environment remediation plan with owners, dependencies, and validation checks.",
    },
    starter_prompt_variants: [
      {
        id: "remediation-template-agent",
        project_source: "template",
        mode: "agent",
        text: "Create a template remediation plan with ordered changes, dependencies, and validation checks.",
        weight: 1,
      },
      {
        id: "remediation-sync-agent",
        project_source: "sync",
        mode: "agent",
        text: "Create a live-environment remediation plan with owners, dependencies, and validation checks.",
        weight: 1,
      },
    ],
    system_instructions:
      "Use the Remediation lens. Convert evidence into ordered fixes, owners, dependencies, risk sequencing, validation checks, rollback notes, and measurable completion criteria.",
    default_settings: { ...baseSettings },
    required_capabilities: ["projects:read", "reports:read", "ask:run"],
    allowed_toolsets: ["projects", "reports", "rules"],
    output_contract: {
      sections: ["plan", "dependencies", "validation", "rollback"],
    },
  },
];

export const getBundledAgentProfiles = (): AgentProfile[] =>
  BUNDLED_AGENT_PROFILES.map((profile) => ({
    ...profile,
    starter_prompts: { ...(profile.starter_prompts ?? {}) },
    starter_prompt_variants: profile.starter_prompt_variants?.map((variant) => ({
      ...variant,
    })),
    default_settings: { ...profile.default_settings },
    required_capabilities: [...profile.required_capabilities],
    allowed_toolsets: [...profile.allowed_toolsets],
    output_contract: profile.output_contract
      ? { ...profile.output_contract }
      : undefined,
  }));

export const getBundledAgentProfile = (
  profileId: string,
): AgentProfile | undefined =>
  getBundledAgentProfiles().find((profile) => profile.id === profileId);
