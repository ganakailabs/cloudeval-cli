import assert from "node:assert/strict";
import test from "node:test";
import {
  answerHitlQuestions,
  getInitialHitlOptionIndex,
  nextHitlOptionIndex,
  resolveHitlAnswer,
  summarizeHitlRequest,
} from "./hitlPrompt.js";

const approvalQuestion = {
  id: "approval_0",
  text: "Should I proceed with running Regenerate cost report?",
  options: [
    { id: "approve", label: "Approve", recommended: true },
    { id: "reject", label: "Reject" },
  ],
};

test("answerHitlQuestions does not approve a recommended option from blank enter", async () => {
  const prompts: string[] = [];
  const responses = await answerHitlQuestions([approvalQuestion], async (prompt) => {
    prompts.push(prompt);
    return "";
  });

  assert.deepEqual(responses, []);
  assert.match(prompts[0], /1\. Approve \(recommended\)/);
  assert.match(prompts[0], /2\. Reject/);
  assert.doesNotMatch(prompts[0], /Choose option \[1\]/);
});

test("answerHitlQuestions accepts numbered options", async () => {
  const responses = await answerHitlQuestions([approvalQuestion], async () => "2");

  assert.deepEqual(responses, [{ question_id: "approval_0", answer: "reject" }]);
});

test("resolveHitlAnswer requires explicit option input", () => {
  assert.equal(resolveHitlAnswer(approvalQuestion, ""), undefined);
  assert.equal(resolveHitlAnswer(approvalQuestion, "yes"), "approve");
  assert.equal(resolveHitlAnswer(approvalQuestion, "no"), "reject");
  assert.equal(resolveHitlAnswer(approvalQuestion, "1"), "approve");
});

test("HITL option navigation starts with no selected approval", () => {
  assert.equal(getInitialHitlOptionIndex(approvalQuestion), -1);
  assert.equal(nextHitlOptionIndex(-1, 1, approvalQuestion.options.length), 0);
  assert.equal(nextHitlOptionIndex(-1, -1, approvalQuestion.options.length), 1);
  assert.equal(nextHitlOptionIndex(0, -1, approvalQuestion.options.length), 1);
});

test("summarizeHitlRequest reports the pending action without implying an empty response", () => {
  const summary = summarizeHitlRequest({
    questions: [approvalQuestion],
    checkpointId: "ckpt-123",
    frontendUrl: "https://cloudeval.ai/app/chat?threadId=thread-1",
  });

  assert.match(summary, /Human input required/);
  assert.match(summary, /Regenerate cost report/);
  assert.match(summary, /cloudeval agent/);
  assert.doesNotMatch(summary, /No final response/);
});
