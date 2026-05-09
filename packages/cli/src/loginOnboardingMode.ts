export type LoginOnboardingMode = "interactive_steps" | "quick_setup";

export const resolveLoginOnboardingMode = (options: {
  headlessRequested: boolean;
  headlessEnvironment: boolean;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
}): LoginOnboardingMode => {
  if (options.headlessRequested || options.headlessEnvironment) {
    return "quick_setup";
  }

  if (!options.stdinIsTTY || !options.stdoutIsTTY) {
    return "quick_setup";
  }

  return "interactive_steps";
};
