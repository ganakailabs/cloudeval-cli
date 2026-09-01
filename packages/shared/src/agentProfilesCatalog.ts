import type { AgentProfile } from "./types";

const baseSettings = {
  mode: "agent" as const,
  response_length: "Detailed",
  technicality: "Expert",
  reasoning_effort: "medium",
  enable_judge: true,
  enable_hitl: true,
};

const outputContract = (include: string[]) => ({
  style: "evidence_backed_review",
  include,
});

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
    output_contract: outputContract([
      "top_architecture_risk",
      "dependency_or_blast_radius_evidence",
      "well_architected_tradeoff",
      "next_design_action",
      "verification_checkpoint",
    ]),
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
    output_contract: outputContract([
      "cost_driver_or_waste_signal",
      "period_or_currency_context",
      "savings_confidence",
      "next_savings_action",
      "verification_checkpoint",
    ]),
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
    output_contract: outputContract([
      "likely_failure_domain",
      "blast_radius",
      "containment_step",
      "verification_check",
      "monitor_or_rollback_signal",
    ]),
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
    output_contract: outputContract([
      "ordered_fix",
      "owner",
      "dependency",
      "rollout_caution",
      "validation_check",
    ]),
  },
  {
    id: "visual-explainer",
    display_name: "Visual Explainer",
    description:
      "Explains topology, dependencies, blast radius, and evidence gaps with grounded visual artifacts.",
    personality: "Visual, topology-aware, concise, and careful about evidence boundaries.",
    accent_key: "cyan",
    icon_key: "diagram",
    default_mode: "agent",
    starter_prompt:
      "Explain this project visually with grounded topology, dependencies, blast radius, and evidence gaps.",
    starter_prompts: {
      template:
        "Explain this template visually: topology, dependencies, blast radius, ownership boundaries, and evidence gaps.",
      sync:
        "Explain this live environment visually: topology, dependencies, blast radius, ownership boundaries, and evidence gaps.",
    },
    starter_prompt_variants: [
      {
        id: "visual-explainer-template-agent",
        project_source: "template",
        mode: "agent",
        text: "Create a grounded visual explanation of this template with topology, dependencies, blast radius, and evidence gaps.",
        weight: 1,
      },
      {
        id: "visual-explainer-sync-agent",
        project_source: "sync",
        mode: "agent",
        text: "Create a grounded visual explanation of this live environment with topology, dependencies, blast radius, and evidence gaps.",
        weight: 1,
      },
    ],
    system_instructions:
      "Use the Visual Explainer lens. Explain visually only when supplied evidence supports real relationships. Never create placeholder topology; state missing relationship evidence as an evidence gap.",
    default_settings: { ...baseSettings },
    required_capabilities: ["projects:read", "reports:read", "ask:run"],
    allowed_toolsets: ["projects", "reports", "graph", "visualization"],
    output_contract: outputContract([
      "visual_evidence",
      "dependency_or_blast_radius_path",
      "diagram_or_map",
      "evidence_gap",
      "recovery_check",
    ]),
  },
  {
    id: "scripter",
    display_name: "Scripter",
    description:
      "Turns evidence-backed recommendations into safe copyable scripts, commands, CI snippets, and validation runbooks.",
    personality: "Practical, safety-minded, automation-oriented, and explicit about dry-run and rollback steps.",
    accent_key: "slate",
    icon_key: "terminal",
    default_mode: "agent",
    starter_prompt:
      "Create safe scriptable remediation or validation commands with dry-run, validation, and rollback notes.",
    starter_prompts: {
      template:
        "Create safe scriptable remediation or validation commands for this template, including dry-run and rollback notes.",
      sync:
        "Create safe scriptable remediation or validation commands for this live environment, including dry-run and rollback notes.",
    },
    starter_prompt_variants: [
      {
        id: "scripter-template-agent",
        project_source: "template",
        mode: "agent",
        text: "Create a copyable script/runbook for this template: prerequisites, dry-run, command, validation, and rollback.",
        weight: 1,
      },
      {
        id: "scripter-sync-agent",
        project_source: "sync",
        mode: "agent",
        text: "Create a copyable script/runbook for this live environment: prerequisites, dry-run, command, validation, and rollback.",
        weight: 1,
      },
    ],
    system_instructions:
      "Use the Scripter lens. Produce copyable scripts, commands, YAML, or runbook snippets with dry-run, validation, and rollback notes. Do not claim files were written or commands were executed unless tool output proves it.",
    default_settings: { ...baseSettings },
    required_capabilities: ["projects:read", "reports:read", "ask:run"],
    allowed_toolsets: ["projects", "reports", "rules"],
    output_contract: outputContract([
      "script_or_command",
      "target_shell_or_runtime",
      "dry_run_step",
      "validation_step",
      "rollback_note",
    ]),
  },
  {
    id: "change-reviewer",
    display_name: "Change Reviewer",
    description:
      "Reviews PRs, diffs, GitHub Actions failures, and release readiness against CloudEval evidence and live Azure sync when available.",
    personality: "Delta-first, release-aware, evidence-strict, and decisive.",
    accent_key: "violet",
    icon_key: "git-pull-request",
    default_mode: "agent",
    starter_prompt:
      "Review this infrastructure change as a delta with a PASS, WARN, or BLOCK decision.",
    starter_prompts: {
      template:
        "Review this infrastructure change as a delta: Current/base state, Proposed change, PR gate evidence, and merge decision.",
      sync:
        "Review this infrastructure change against live Azure: Current/base state, Proposed change, Deployed/live Azure state, and merge decision.",
    },
    starter_prompt_variants: [
      {
        id: "change-reviewer-template-agent",
        project_source: "template",
        mode: "agent",
        text: "Review this PR as a delta: current/base, proposed change, stale evidence gaps, validation failures, and merge decision.",
        weight: 1,
      },
      {
        id: "change-reviewer-sync-agent",
        project_source: "sync",
        mode: "agent",
        text: "Review this change against live Azure: current/base source, proposed diff, deployed state, freshness gaps, and release decision.",
        weight: 1,
      },
    ],
    system_instructions:
      "Use the Change Reviewer lens. Separate Current/base, Proposed change, and Deployed/live Azure when available. Lead with PASS, WARN, or BLOCK and classify new regressions separately from inherited risk.",
    default_settings: { ...baseSettings },
    required_capabilities: ["projects:read", "reports:read", "ask:run"],
    allowed_toolsets: ["projects", "reports", "graph", "rules"],
    output_contract: outputContract([
      "decision",
      "current_base_state",
      "proposed_change",
      "live_azure_state",
      "regression_classification",
      "github_actions_failure_domain",
      "evidence_freshness",
    ]),
  },
  {
    id: "evidence-auditor",
    display_name: "Evidence Auditor",
    description:
      "Audits whether reports, answers, findings, and review decisions are trustworthy and fresh enough to act on.",
    personality: "Skeptical, precise, provenance-oriented, and honest about Not assessed areas.",
    accent_key: "indigo",
    icon_key: "search-check",
    default_mode: "agent",
    starter_prompt:
      "Audit the evidence behind this review: source coverage, freshness, provenance, confidence, and Not assessed gaps.",
    starter_prompts: {
      template:
        "Audit the evidence behind this template review: source coverage, freshness, provenance, confidence, and Not assessed gaps.",
      sync:
        "Audit the evidence behind this live environment review: source coverage, freshness, provenance, confidence, and Not assessed gaps.",
    },
    starter_prompt_variants: [
      {
        id: "evidence-auditor-template-agent",
        project_source: "template",
        mode: "agent",
        text: "Audit this template review for source coverage, freshness, scanner provenance, confidence, and overstated claims.",
        weight: 1,
      },
      {
        id: "evidence-auditor-sync-agent",
        project_source: "sync",
        mode: "agent",
        text: "Audit this live review for source coverage, freshness, scanner provenance, confidence, and overstated claims.",
        weight: 1,
      },
    ],
    system_instructions:
      "Use the Evidence Auditor lens. Prioritize source coverage, freshness, scanner provenance, report timestamps, confidence, unsupported areas, and Not assessed gaps. Flag stale artifacts and overstated claims.",
    default_settings: { ...baseSettings },
    required_capabilities: ["projects:read", "reports:read", "ask:run"],
    allowed_toolsets: ["projects", "reports", "rules"],
    output_contract: outputContract([
      "source_coverage",
      "freshness_check",
      "provenance",
      "confidence_or_not_assessed_gap",
      "overclaim_risk",
    ]),
  },
  {
    id: "security-reviewer",
    display_name: "Security Reviewer",
    description:
      "Reviews exposure, identity, network boundaries, secrets, policy controls, and attack paths.",
    personality: "Threat-aware, evidence-backed, control-focused, and pragmatic.",
    accent_key: "red",
    icon_key: "shield-alert",
    default_mode: "agent",
    starter_prompt:
      "Review this project for security risk: exposure, identity, network boundaries, secrets, controls, and attack paths.",
    starter_prompts: {
      template:
        "Review this template for security risk: exposure, identity, network boundaries, secrets, controls, and attack paths.",
      sync:
        "Review this live environment for security risk: exposure, identity, network boundaries, secrets, controls, and attack paths.",
    },
    starter_prompt_variants: [
      {
        id: "security-reviewer-template-agent",
        project_source: "template",
        mode: "agent",
        text: "Run a security review on this template: exposure, identity, network boundary, control mapping, fix, and checkpoint.",
        weight: 1,
      },
      {
        id: "security-reviewer-sync-agent",
        project_source: "sync",
        mode: "agent",
        text: "Run a security review on this live project: exposure, identity, network boundary, control mapping, fix, and checkpoint.",
        weight: 1,
      },
    ],
    system_instructions:
      "Use the Security Reviewer lens. Prioritize exposure, identity, network boundaries, secrets, policy controls, and attack paths. Tie every security claim to supplied evidence.",
    default_settings: { ...baseSettings },
    required_capabilities: ["projects:read", "reports:read", "ask:run"],
    allowed_toolsets: ["projects", "reports", "graph", "rules"],
    output_contract: outputContract([
      "security_risk",
      "attack_path_or_exposure",
      "identity_or_network_boundary",
      "control_or_policy_mapping",
      "prioritized_fix",
      "validation_checkpoint",
    ]),
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
