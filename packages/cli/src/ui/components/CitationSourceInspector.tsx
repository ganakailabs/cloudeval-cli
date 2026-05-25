import React from "react";
import { Box, Text } from "ink";
import type { CitationReference } from "../citationContent.js";
import { terminalTheme } from "../theme.js";

const ALIGNMENT_LOW_SCORE = 70;

export interface CitationSourceInspectorProps {
  reference: CitationReference | null;
  onClose?: () => void;
}

export const CitationSourceInspector: React.FC<CitationSourceInspectorProps> = ({
  reference,
  onClose: _onClose,
}) => {
  if (!reference) {
    return null;
  }

  const lowConfidence =
    typeof reference.alignment_score === "number" &&
    reference.alignment_score < ALIGNMENT_LOW_SCORE;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={terminalTheme.brand}
      paddingX={1}
      marginTop={1}
    >
      <Text color={terminalTheme.brand} bold>
        Source [{reference.number}]
      </Text>
      <Text wrap="wrap">{reference.label}</Text>
      {reference.url ? (
        <Text dimColor wrap="wrap">
          {reference.url}
        </Text>
      ) : null}
      {reference.quote ? (
        <Text dimColor wrap="wrap">
          {reference.quote}
        </Text>
      ) : null}
      {reference.loc ? (
        <Text dimColor wrap="wrap">
          {reference.loc}
        </Text>
      ) : null}
      {lowConfidence ? (
        <Text color={terminalTheme.warning}>~low confidence</Text>
      ) : null}
      {reference.origin === "fallback" ? (
        <Text dimColor>origin: fallback (synthetic placement)</Text>
      ) : null}
      <Text dimColor>Press Esc to close</Text>
    </Box>
  );
};
