import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recipes } from "../recipes/catalog.js";

export interface SkillMetadata {
  id: string;
  title: string;
  description: string;
}

export interface SkillSummary extends SkillMetadata {
  path?: string;
  source: "filesystem" | "embedded";
  recipes: string[];
  mcpTools: string[];
}

export interface SkillDefinition extends SkillSummary {
  content: string;
}

export interface SkillDoctorCheck {
  id: string;
  status: "pass" | "fail";
  message: string;
  file?: string;
}

export interface SkillDoctorResult {
  ok: boolean;
  skillsPath: string;
  skills: SkillSummary[];
  checks: SkillDoctorCheck[];
}

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const defaultSkillsPath = path.join(repoRoot, "skills");

export const requiredSkillSections = [
  "## WHEN",
  "## DO NOT USE FOR",
  "## Required CloudEval Context",
  "## CLI Commands",
  "## MCP Tools",
  "## Safety Requirements",
  "## Expected Output / Proof",
  "## Failure Handling",
] as const;

export const bundledSkillMetadata: SkillMetadata[] = [
  {
    id: "cloudeval",
    title: "CloudEval Skill Router",
    description:
      "Routes CloudEval CLI and MCP work across projects, reports, billing, credentials, connections, diagnostics, recipes, and agent workflows.",
  },
  {
    id: "cloudeval-agent-ops",
    title: "CloudEval Agent Ops",
    description:
      "Runs CloudEval ask, agent, chat/TUI, model selection, recipes, and local session recovery.",
  },
  {
    id: "cloudeval-billing",
    title: "CloudEval Billing",
    description:
      "Inspects CloudEval credits, plans, usage, ledger, invoices, notifications, top-ups, and checkout links.",
  },
  {
    id: "cloudeval-connections",
    title: "CloudEval Connections",
    description:
      "Inspects CloudEval cloud/template connections, connection health, and connection frontend links.",
  },
  {
    id: "cloudeval-cost",
    title: "CloudEval Cost",
    description:
      "Triages CloudEval cost reports, billing usage, savings opportunities, anomalies, and credit impact.",
  },
  {
    id: "cloudeval-credentials",
    title: "CloudEval Credentials",
    description:
      "Manages CloudEval scoped access-key templates, creation, inspection, rotation, and revocation.",
  },
  {
    id: "cloudeval-graph-intelligence",
    title: "CloudEval Graph Intelligence",
    description:
      "Inspects project graphs, graph drift, sync history, dependency impact, critical paths, and graph-derived risk signals.",
  },
  {
    id: "cloudeval-mcp-diagnostics",
    title: "CloudEval MCP Diagnostics",
    description:
      "Sets up and diagnoses CloudEval MCP, config, auth, doctor, status, update, completion, banner, and deeplinks.",
  },
  {
    id: "cloudeval-projects",
    title: "CloudEval Projects",
    description:
      "Lists, inspects, creates, opens, and health-checks CloudEval projects and template project workflows.",
  },
  {
    id: "cloudeval-reports",
    title: "CloudEval Reports",
    description:
      "Lists, shows, generates, downloads, and summarizes CloudEval cost and Well-Architected reports.",
  },
  {
    id: "cloudeval-template-validation",
    title: "CloudEval Template Validation",
    description:
      "Validates, parses, tests, and release-gates CloudEval-supported cloud template files.",
  },
  {
    id: "cloudeval-visualizations",
    title: "CloudEval Visualizations",
    description:
      "Exports CloudEval architecture or dependency diagrams and prepares visual evidence for reviews.",
  },
  {
    id: "cloudeval-waf",
    title: "CloudEval WAF",
    description:
      "Triages CloudEval Well-Architected findings, failed rules, pillar risk, and remediation plans.",
  },
];

const metadataById = new Map(bundledSkillMetadata.map((skill) => [skill.id, skill]));

const normalizeSkillId = (id: string): string => {
  const normalized = id.trim().toLowerCase();
  if (metadataById.has(normalized)) {
    return normalized;
  }
  const prefixed = `cloudeval-${normalized}`;
  return metadataById.has(prefixed) ? prefixed : normalized;
};

export const getSkillsPath = (): string => process.env.CLOUDEVAL_SKILLS_PATH ?? defaultSkillsPath;

const skillFilePath = (id: string): string => path.join(getSkillsPath(), id, "SKILL.md");

const fileExists = (filePath: string): boolean => {
  try {
    return fsSync.statSync(filePath).isFile();
  } catch {
    return false;
  }
};

const readSkillFile = async (id: string): Promise<{ content: string; path?: string; source: "filesystem" | "embedded" }> => {
  const filePath = skillFilePath(id);
  if (fileExists(filePath)) {
    return {
      content: await fs.readFile(filePath, "utf8"),
      path: filePath,
      source: "filesystem",
    };
  }
  return {
    content: synthesizeSkillContent(metadataById.get(id) ?? {
      id,
      title: id,
      description: "CloudEval skill metadata.",
    }),
    source: "embedded",
  };
};

const recipesForSkill = (id: string) =>
  recipes.filter((recipe) => recipe.skill === id);

const unique = (values: string[]): string[] =>
  [...new Set(values)].filter(Boolean).sort();

const summarizeSkill = async (metadata: SkillMetadata): Promise<SkillSummary> => {
  const file = await readSkillFile(metadata.id);
  const skillRecipes = recipesForSkill(metadata.id);
  return {
    ...metadata,
    path: file.path,
    source: file.source,
    recipes: skillRecipes.map((recipe) => recipe.id),
    mcpTools: unique(skillRecipes.flatMap((recipe) => recipe.mcpTools)),
  };
};

export const listSkills = async (): Promise<SkillSummary[]> =>
  Promise.all(bundledSkillMetadata.map(summarizeSkill));

export const getSkill = async (id: string): Promise<SkillDefinition | undefined> => {
  const normalized = normalizeSkillId(id);
  const metadata = metadataById.get(normalized);
  if (!metadata) {
    return undefined;
  }
  const [summary, file] = await Promise.all([
    summarizeSkill(metadata),
    readSkillFile(metadata.id),
  ]);
  return {
    ...summary,
    content: file.content,
  };
};

const synthesizeSkillContent = (metadata: SkillMetadata): string => `---
name: ${metadata.id}
description: ${metadata.description}
---

# ${metadata.title}

## WHEN
- Use this bundled CloudEval skill when source SKILL.md files are unavailable at runtime.

## DO NOT USE FOR
- Unsupported CloudEval capabilities or private backend internals.

## Required CloudEval Context
- Run \`cloudeval capabilities --format json\` and \`cloudeval recipes list\` to discover available commands.

## CLI Commands
- \`cloudeval skills show ${metadata.id}\`
- \`cloudeval recipes list\`

## MCP Tools
- \`capabilities_get\`
- \`recipes_list\`

## Safety Requirements
- Redact secrets, account identifiers, session identifiers, tenant identifiers, billing data, and raw report payloads by default.

## Expected Output / Proof
- State the command or MCP tool used and separate confirmed evidence from missing data.

## Failure Handling
- If the source skill file is needed, run from a CloudEval CLI checkout or inspect the public repository.
`;

const frontMatterNamePattern = (id: string): RegExp =>
  new RegExp(`^---[\\s\\S]*?^name:\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$[\\s\\S]*?^---`, "m");

const sensitivePatterns = [
  /sk-or-v1-[a-z0-9]{16,}/i,
  /sk-[a-z0-9]{20,}/i,
  /ghp_[a-z0-9]{20,}/i,
  /xox[baprs]-[a-z0-9-]{20,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

const unsupportedClaims = [
  /\bterraform\b/i,
  /\bpull request\b/i,
  /\bgithub pr\b/i,
  /\bpr integration\b/i,
];

const validateSkillText = (id: string, text: string, file?: string): SkillDoctorCheck[] => {
  const checks: SkillDoctorCheck[] = [];
  checks.push({
    id: `${id}:frontmatter-name`,
    status: frontMatterNamePattern(id).test(text) ? "pass" : "fail",
    message: `Skill ${id} declares matching frontmatter name.`,
    file,
  });
  for (const section of requiredSkillSections) {
    checks.push({
      id: `${id}:section:${section.replace(/^##\s+/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      status: text.includes(section) ? "pass" : "fail",
      message: `Skill ${id} includes ${section}.`,
      file,
    });
  }
  for (const pattern of sensitivePatterns) {
    checks.push({
      id: `${id}:no-sensitive-pattern:${pattern.source.slice(0, 24)}`,
      status: pattern.test(text) ? "fail" : "pass",
      message: `Skill ${id} does not contain obvious secret patterns.`,
      file,
    });
  }
  for (const pattern of unsupportedClaims) {
    checks.push({
      id: `${id}:no-unsupported-claim:${pattern.source}`,
      status: pattern.test(text) ? "fail" : "pass",
      message: `Skill ${id} does not claim unsupported workflows.`,
      file,
    });
  }
  return checks;
};

export const validateSkills = async (): Promise<SkillDoctorResult> => {
  const skills = await listSkills();
  const knownIds = new Set(skills.map((skill) => skill.id));
  const checks: SkillDoctorCheck[] = [];

  for (const recipe of recipes) {
    checks.push({
      id: `recipe:${recipe.id}:skill-exists`,
      status: knownIds.has(recipe.skill) ? "pass" : "fail",
      message: `Recipe ${recipe.id} references implemented skill ${recipe.skill}.`,
    });
  }

  for (const skill of skills) {
    const file = await readSkillFile(skill.id);
    checks.push({
      id: `${skill.id}:source`,
      status: file.source === "filesystem" ? "pass" : "fail",
      message: `Skill ${skill.id} has a public SKILL.md file.`,
      file: file.path,
    });
    checks.push(...validateSkillText(skill.id, file.content, file.path));
  }

  return {
    ok: checks.every((check) => check.status === "pass"),
    skillsPath: getSkillsPath(),
    skills,
    checks,
  };
};

export const skillsResourceData = async () => ({
  skillsPath: getSkillsPath(),
  skills: await listSkills(),
  requiredSections: [...requiredSkillSections],
});
