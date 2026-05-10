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
    "cost-review",
    "waf-triage",
    "architecture-review",
    "template-project-review",
    "report-summary",
    "billing-review",
    "diagram-export",
    "mcp-setup",
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
    assert(recipe.safety.requiresAuth === true || recipe.id === "mcp-setup");
    assert.equal(typeof recipe.safety.consumesCredits, "boolean");
    assert.equal(typeof recipe.safety.writesLocalFile, "boolean");
    assert.equal(typeof recipe.safety.mayExposeSensitiveData, "boolean");
  }
});

test("recipe prompt rendering uses existing CloudEval command context", () => {
  const recipe = getRecipe("cost-review");
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
    "cloudeval-mcp-diagnostics",
  ];
  for (const skill of requiredSkills) {
    const text = await fs.readFile(path.join(repoRoot, "skills", skill, "SKILL.md"), "utf8");
    assert.match(text, /^---\nname: /);
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
