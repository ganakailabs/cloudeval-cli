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

type BannerSegmentTone = "fill" | "outline" | "space";

const outlineGlyphs = new Set(["╔", "╗", "╚", "╝", "═", "║", "╦", "╩", "╠", "╣"]);

const bannerSegmentTone = (character: string): BannerSegmentTone => {
  if (character === " ") {
    return "space";
  }
  return outlineGlyphs.has(character) ? "outline" : "fill";
};

export const splitBannerLineSegments = (
  line: string
): Array<{ text: string; tone: BannerSegmentTone }> => {
  const segments: Array<{ text: string; tone: BannerSegmentTone }> = [];
  for (const character of line) {
    const tone = bannerSegmentTone(character);
    const previous = segments.at(-1);
    if (previous?.tone === tone) {
      previous.text += character;
    } else {
      segments.push({ text: character, tone });
    }
  }
  return segments;
};

const bannerSegmentColor = (tone: BannerSegmentTone): string | undefined => {
  if (tone === "outline") {
    return terminalTheme.brand;
  }
  if (tone === "fill") {
    return terminalTheme.accent;
  }
  return undefined;
};

const BannerArtLine: React.FC<{ line: string }> = ({ line }) => (
  <Text>
    {splitBannerLineSegments(line).map((segment, index) => (
      <Text
        key={`${index}-${segment.text}`}
        color={bannerSegmentColor(segment.tone)}
      >
        {segment.text}
      </Text>
    ))}
  </Text>
);

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
                <BannerArtLine key={line} line={line} />
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
