import assert from "node:assert/strict";
import test from "node:test";
import { answerHitlQuestions, summarizeHitlRequest } from "./hitlPrompt.js";

const approvalQuestion = {
  id: "approval_0",
  text: "Should I proceed with running Regenerate cost report?",
  options: [
    { id: "approve", label: "Approve", recommended: true },
    { id: "reject", label: "Reject" },
  ],
};

test("answerHitlQuestions uses the recommended option when the user presses enter", async () => {
  const prompts: string[] = [];
  const responses = await answerHitlQuestions([approvalQuestion], async (prompt) => {
    prompts.push(prompt);
    return "";
  });

  assert.deepEqual(responses, [{ question_id: "approval_0", answer: "approve" }]);
  assert.match(prompts[0], /1\. Approve \(recommended\)/);
  assert.match(prompts[0], /2\. Reject/);
});

test("answerHitlQuestions accepts numbered options", async () => {
  const responses = await answerHitlQuestions([approvalQuestion], async () => "2");

  assert.deepEqual(responses, [{ question_id: "approval_0", answer: "reject" }]);
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
