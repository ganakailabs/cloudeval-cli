import React from "react";
import { Box, Text } from "ink";
import { terminalTheme } from "../theme.js";
import { CLI_VERSION } from "../../version.js";

export interface BannerProps {
  disable?: boolean;
  details?: string[];
  terminalColumns?: number;
}

const wordArt = [
  " ██████╗  ██╗       ██████╗  ██╗   ██╗ ██████╗  ███████╗ ██╗   ██╗  █████╗  ██╗     ",
  "██╔════╝  ██║      ██╔═══██╗ ██║   ██║ ██╔══██╗ ██╔════╝ ██║   ██║ ██╔══██╗ ██║     ",
  "██║       ██║      ██║   ██║ ██║   ██║ ██║  ██║ █████╗   ██║   ██║ ███████║ ██║     ",
  "██║       ██║      ██║   ██║ ██║   ██║ ██║  ██║ ██╔══╝   ╚██╗ ██╔╝ ██╔══██║ ██║     ",
  "╚██████╗  ███████╗ ╚██████╔╝ ╚██████╔╝ ██████╔╝ ███████╗  ╚████╔╝  ██║  ██║ ███████╗",
  " ╚═════╝  ╚══════╝  ╚═════╝   ╚═════╝  ╚═════╝  ╚══════╝   ╚═══╝   ╚═╝  ╚═╝ ╚══════╝",
];

const artWidth = (art: string[]): number => Math.max(...art.map((line) => line.length));

export const Banner: React.FC<BannerProps> = ({
  disable = false,
  details = [],
  terminalColumns,
}) => {
  if (disable) return null;

  const columns = terminalColumns ?? process.stdout.columns ?? 100;
  const art = wordArt;
  const width = artWidth(art);
  const showArt = columns >= width;
  const showDetailsBesideArt = showArt && details.length > 0 && columns >= width + 42;
  const version = process.env.CLOUDEVAL_CLI_VERSION ?? CLI_VERSION;

  return (
    <Box flexDirection="column" alignItems="flex-start" marginBottom={1}>
      {showArt ? (
        <>
          <Text color={terminalTheme.success}>Welcome to</Text>
          <Box flexDirection="row" gap={2}>
            <Box flexDirection="column">
              {art.map((line) => (
                <Text key={line} color={terminalTheme.accent}>
                  {line}
                </Text>
              ))}
            </Box>
            {showDetailsBesideArt ? (
              <Box flexDirection="column" paddingTop={1}>
                <Text color={terminalTheme.success}>CLI v{version}</Text>
                {details.map((detail) => (
                  <Text key={detail} dimColor wrap="truncate">
                    {detail}
                  </Text>
                ))}
              </Box>
            ) : null}
          </Box>
        </>
      ) : null}
      {!showDetailsBesideArt ? (
        <>
          <Text color={terminalTheme.success}>CLI v{version}</Text>
          {details.map((detail) => (
            <Text key={detail} dimColor wrap="truncate">
              {detail}
            </Text>
          ))}
        </>
      ) : null}
    </Box>
  );
};
