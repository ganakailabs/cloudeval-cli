import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { HitlQuestion, HitlResponse } from "@cloudeval/shared";

export const HITL_REQUIRED_EXIT_CODE = 6;

type AskFn = (prompt: string) => Promise<string>;

type HitlSummaryOptions = {
  questions: HitlQuestion[];
  checkpointId?: string;
  frontendUrl?: string;
};

export const NO_HITL_OPTION_SELECTED = -1;

export const getInitialHitlOptionIndex = (_question?: HitlQuestion): number =>
  NO_HITL_OPTION_SELECTED;

export const nextHitlOptionIndex = (
  current: number,
  direction: 1 | -1,
  optionCount: number
): number => {
  if (optionCount <= 0) {
    return NO_HITL_OPTION_SELECTED;
  }
  if (current < 0 || current >= optionCount) {
    return direction > 0 ? 0 : optionCount - 1;
  }
  return (current + direction + optionCount) % optionCount;
};

const optionLines = (question: HitlQuestion): string[] =>
  (question.options ?? []).map((option, index) => {
    const isRecommended =
      option.id === question.recommended_option_id || option.recommended;
    return `${index + 1}. ${option.label}${isRecommended ? " (recommended)" : ""}`;
  });

export const resolveHitlAnswer = (
  question: HitlQuestion,
  rawAnswer: string
): string | undefined => {
  const options = question.options ?? [];
  const trimmed = rawAnswer.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!options.length) {
    return trimmed;
  }

  const number = Number(trimmed);
  if (Number.isInteger(number) && number >= 1 && number <= options.length) {
    return options[number - 1]!.id;
  }

  const lower = trimmed.toLowerCase();
  const direct = options.find((option) =>
    option.id.toLowerCase() === lower || option.label.toLowerCase() === lower
  );
  if (direct) {
    return direct.id;
  }

  const yesNoMatch = options.find((option) => {
    const value = `${option.id} ${option.label}`.toLowerCase();
    if (/^(y|yes)$/i.test(trimmed)) {
      return /approve|allow|yes|proceed|confirm|accept/.test(value);
    }
    if (/^(n|no)$/i.test(trimmed)) {
      return /reject|deny|no|cancel|decline/.test(value);
    }
    return false;
  });
  if (yesNoMatch) {
    return yesNoMatch.id;
  }

  return trimmed;
};

const questionPrompt = (question: HitlQuestion, index: number, total: number): string => {
  const lines = [
    `Human input required (${index + 1}/${total})`,
    question.text || "Action required",
  ];
  const options = optionLines(question);
  if (options.length) {
    lines.push("", ...options);
    lines.push("", "Choose option: ");
  } else {
    lines.push("", "Answer: ");
  }
  return lines.join("\n");
};

export const answerHitlQuestions = async (
  questions: HitlQuestion[],
  ask: AskFn
): Promise<HitlResponse[]> => {
  const responses: HitlResponse[] = [];
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]!;
    const answer = await ask(questionPrompt(question, index, questions.length));
    const resolved = resolveHitlAnswer(question, answer);
    if (resolved) {
      responses.push({ question_id: question.id, answer: resolved });
    }
  }
  return responses;
};

export const promptForHitlResponses = async (
  questions: HitlQuestion[],
  input: Readable = process.stdin,
  output: Writable = process.stderr
): Promise<HitlResponse[]> => {
  const rl = createInterface({ input, output });
  try {
    return await answerHitlQuestions(questions, (prompt) => rl.question(prompt));
  } finally {
    rl.close();
  }
};

export const summarizeHitlRequest = (options: HitlSummaryOptions): string => {
  const firstQuestion = options.questions[0];
  const lines = [
    "Human input required by CloudEval.",
    firstQuestion?.text ? `Action: ${firstQuestion.text}` : undefined,
    firstQuestion?.options?.length
      ? `Options: ${firstQuestion.options.map((option) => option.label).join(", ")}`
      : undefined,
    options.checkpointId ? "A resumable checkpoint is available." : undefined,
    options.frontendUrl ? `Frontend: ${options.frontendUrl}` : undefined,
    "Run `cloudeval agent ...` in an interactive terminal to answer the approval prompt, or open the frontend thread.",
  ].filter((line): line is string => Boolean(line));
  return `${lines.join("\n")}\n`;
};
