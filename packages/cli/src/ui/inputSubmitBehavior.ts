import { sanitizeTerminalMultilineInput } from "./inputSanitizer.js";

export const shouldSubmitInputOnReturn = (value: string): boolean =>
  sanitizeTerminalMultilineInput(value).trim().length > 0;
