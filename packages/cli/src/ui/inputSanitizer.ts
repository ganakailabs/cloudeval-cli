const SGR_MOUSE_SEQUENCE = /\x1b?\[<\d+;\d+;\d+[mM]/g;
const CSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;
const CONTROL_CHARACTERS_EXCEPT_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F]/g;

export const sanitizeTerminalInput = (value: string): string =>
  value
    .replace(SGR_MOUSE_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(CONTROL_CHARACTERS, "");

export const sanitizeTerminalMultilineInput = (value: string): string =>
  value
    .replace(SGR_MOUSE_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARACTERS_EXCEPT_NEWLINE, "");
