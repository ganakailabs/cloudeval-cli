import assert from "node:assert/strict";
import test from "node:test";
import {
  bundledSkillMetadata,
  getSkill,
  listSkills,
  requiredSkillSections,
  skillsResourceData,
  validateSkills,
} from "./catalog.js";
import { recipes } from "../recipes/catalog.js";

test("bundled skill metadata covers every recipe skill", async () => {
  const skills = await listSkills();
  const skillIds = new Set(skills.map((skill) => skill.id));

  for (const recipe of recipes) {
    assert.equal(
      skillIds.has(recipe.skill),
      true,
      `${recipe.id} references missing skill ${recipe.skill}`,
    );
  }

  assert(skillIds.has("cloudeval-graph-intelligence"));
  assert(skillIds.has("cloudeval-template-validation"));
});

test("skill doctor validates sections, recipe references, and safety patterns", async () => {
  const doctor = await validateSkills();
  assert.equal(doctor.ok, true, doctor.checks.filter((check) => check.status === "fail").map((check) => check.id).join("\n"));
  assert.equal(doctor.skills.length, bundledSkillMetadata.length);
  assert(doctor.checks.length > doctor.skills.length * requiredSkillSections.length);
});

test("skill lookup supports bare and fully qualified ids", async () => {
  const cost = await getSkill("cost");
  const qualified = await getSkill("cloudeval-cost");

  assert.equal(cost?.id, "cloudeval-cost");
  assert.equal(qualified?.id, "cloudeval-cost");
  assert.match(cost?.content ?? "", /# Cloudeval Cost/);
  assert.match(cost?.content ?? "", /## MCP Tools/);
});

test("skills resource data is MCP friendly", async () => {
  const resource = await skillsResourceData();
  assert(resource.requiredSections.includes("## WHEN"));
  assert(
    resource.skills.some((skill) => skill.id === "cloudeval-template-validation"),
  );
  assert(
    resource.skills.some((skill) => skill.id === "cloudeval-graph-intelligence"),
  );
});
