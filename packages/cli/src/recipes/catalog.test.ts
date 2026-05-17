import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  getRecipe,
  recipeIds,
  recipes,
  renderRecipePrompt,
} from "./catalog.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

test("recipe catalog only exposes implemented CloudEval workflows", () => {
  assert.deepEqual(recipeIds, [
    "cloudeval-cloud-cost-review",
    "cloudeval-well-architected-framework-review",
    "cloudeval-architecture-review",
    "cloudeval-template-project-review",
    "cloudeval-report-summary",
    "cloudeval-report-generation-plan",
    "cloudeval-report-export-pack",
    "cloudeval-billing-review",
    "cloudeval-credit-topup-readiness",
    "cloudeval-project-inventory",
    "cloudeval-project-healthcheck",
    "cloudeval-connection-audit",
    "cloudeval-agent-access-key-setup",
    "cloudeval-credential-rotation",
    "cloudeval-model-selection",
    "cloudeval-session-recovery",
    "cloudeval-cli-onboarding-check",
    "cloudeval-frontend-workspace-links",
    "cloudeval-diagram-export",
    "cloudeval-graph-drift-watch",
    "cloudeval-impact-analysis",
    "cloudeval-template-preflight",
    "cloudeval-template-release-gate",
    "cloudeval-architecture-diagram-export",
    "cloudeval-dependency-diagram-export",
    "cloudeval-mcp-setup",
  ]);

  const serialized = JSON.stringify(recipes).toLowerCase();
  assert.doesNotMatch(serialized, /terraform/);
  assert.doesNotMatch(serialized, /pull request|github pr|pr integration/);

  for (const recipe of recipes) {
    assert.equal(recipe.id, recipe.id.toLowerCase());
    assert(recipe.title.length > 0);
    assert(recipe.description.length > 0);
    assert(recipe.commands.length > 0);
    assert(recipe.skill.length > 0);
    assert(
      recipe.safety.requiresAuth === true ||
        ["cloudeval-mcp-setup", "cloudeval-session-recovery", "cloudeval-cli-onboarding-check", "cloudeval-frontend-workspace-links"].includes(recipe.id)
    );
    assert.equal(typeof recipe.safety.consumesCredits, "boolean");
    assert.equal(typeof recipe.safety.writesLocalFile, "boolean");
    assert.equal(typeof recipe.safety.mayExposeSensitiveData, "boolean");
  }
});

test("recipe prompt rendering uses existing CloudEval command context", () => {
  const recipe = getRecipe("cloudeval-cloud-cost-review");
  assert(recipe);

  const prompt = renderRecipePrompt(recipe, {
    projectId: "project-main",
    range: "30d",
  });

  assert.match(prompt, /cost review/i);
  assert.match(prompt, /project-main/);
  assert.match(prompt, /30d/);
  assert.match(prompt, /CloudEval reports/i);
  assert.doesNotMatch(prompt.toLowerCase(), /terraform/);
});

test("diagram recipes render explicit architecture and dependency export guidance", () => {
  const architecture = getRecipe("cloudeval-architecture-diagram-export");
  const dependency = getRecipe("cloudeval-dependency-diagram-export");
  assert(architecture);
  assert(dependency);

  const architecturePrompt = renderRecipePrompt(architecture, {
    projectId: "project-main",
    outputPath: "out/architecture.png",
  });
  const dependencyPrompt = renderRecipePrompt(dependency, {
    projectId: "project-main",
    outputPath: "out/dependency.svg",
  });

  assert.match(architecturePrompt, /architecture/i);
  assert.match(architecturePrompt, /out\/architecture\.png/);
  assert.match(dependencyPrompt, /dependency/i);
  assert.match(dependencyPrompt, /out\/dependency\.svg/);
});

test("legacy recipe aliases resolve to renamed cloudeval prompt ids", () => {
  assert.equal(getRecipe("cost-review")?.id, "cloudeval-cloud-cost-review");
  assert.equal(getRecipe("waf-triage")?.id, "cloudeval-well-architected-framework-review");
  assert.equal(
    getRecipe("cloudeval-well-architect-framework-review")?.id,
    "cloudeval-well-architected-framework-review",
  );
  assert.equal(
    getRecipe("architecture-diagram-export")?.id,
    "cloudeval-architecture-diagram-export",
  );
});

test("unknown recipes are not resolved", () => {
  assert.equal(getRecipe("terraform-risk-scan"), undefined);
  assert.equal(getRecipe("missing"), undefined);
});

test("public skill files include Azure-style operational sections", async () => {
  const requiredSkills = [
    "cloudeval",
    "cloudeval-agent-ops",
    "cloudeval-projects",
    "cloudeval-reports",
    "cloudeval-cost",
    "cloudeval-waf",
    "cloudeval-billing",
    "cloudeval-connections",
    "cloudeval-credentials",
    "cloudeval-visualizations",
    "cloudeval-mcp-diagnostics",
  ];
  for (const skill of requiredSkills) {
    const text = await fs.readFile(path.join(repoRoot, "skills", skill, "SKILL.md"), "utf8");
    assert.match(text, /^---\r?\nname: /);
    for (const section of [
      "## WHEN",
      "## DO NOT USE FOR",
      "## Required CloudEval Context",
      "## CLI Commands",
      "## MCP Tools",
      "## Safety Requirements",
      "## Expected Output / Proof",
      "## Failure Handling",
    ]) {
      assert.match(text, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.doesNotMatch(text.toLowerCase(), /terraform/);
  }
});
