import React from "react";
import { Box, Text } from "ink";
import type { BannerDetailLine } from "../bannerDetails.js";
import { shouldUseColor, terminalTheme } from "../theme.js";
import { CLI_VERSION } from "../../version.js";

export interface BannerProps {
  disable?: boolean;
  details?: string[];
  detailLines?: BannerDetailLine[];
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

export type BannerSegmentTone = "fill" | "outline" | "space";

const fillGradient = [
  "#ffd60a",
  "#facc15",
  "#fbbf24",
  "#f59e0b",
  "#d97706",
  "#b45309",
];

const outlineGradient = [
  "#ca8a04",
  "#a16207",
  "#92400e",
  "#9a3412",
  "#7c2d12",
  "#7c2d12",
];

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

const gradientIndex = (
  lineIndex: number,
  totalLines: number,
  paletteLength: number
): number => {
  const boundedTotal = Math.max(1, totalLines);
  const boundedLine = Math.min(Math.max(0, lineIndex), boundedTotal - 1);
  const ratio = boundedTotal === 1 ? 0 : boundedLine / (boundedTotal - 1);
  return Math.min(paletteLength - 1, Math.round(ratio * (paletteLength - 1)));
};

export const bannerSegmentColor = (
  tone: BannerSegmentTone,
  lineIndex = 0,
  totalLines = wordArt.length
): string | undefined => {
  if (!shouldUseColor()) {
    return undefined;
  }
  if (tone === "outline") {
    return outlineGradient[gradientIndex(lineIndex, totalLines, outlineGradient.length)];
  }
  if (tone === "fill") {
    return fillGradient[gradientIndex(lineIndex, totalLines, fillGradient.length)];
  }
  return undefined;
};

export const bannerMetaColor = (): string | undefined => terminalTheme.accent;

const BannerArtLine: React.FC<{
  line: string;
  lineIndex: number;
  totalLines: number;
}> = ({ line, lineIndex, totalLines }) => (
  <Text wrap="truncate">
    {splitBannerLineSegments(line).map((segment, index) => (
      <Text
        key={`${index}-${segment.text}`}
        color={bannerSegmentColor(segment.tone, lineIndex, totalLines)}
      >
        {segment.text}
      </Text>
    ))}
  </Text>
);

const BannerDetailText: React.FC<{ line: BannerDetailLine }> = ({ line }) => (
  <Text wrap="truncate">
    {line.segments.map((segment, index) => (
      <Text
        key={`${line.key}-${index}`}
        color={segment.color}
        dimColor={segment.dimColor}
        bold={segment.bold}
      >
        {segment.text}
      </Text>
    ))}
  </Text>
);

export const Banner: React.FC<BannerProps> = ({
  disable = false,
  details = [],
  detailLines = [],
  terminalColumns,
}) => {
  if (disable) return null;

  const columns = terminalColumns ?? process.stdout.columns ?? 100;
  const art = wordArt;
  const width = artWidth(art);
  const showArt = columns >= width;
  const resolvedDetailLines: BannerDetailLine[] =
    detailLines.length > 0
      ? detailLines
      : details.map((detail, index) => ({
          key: `legacy-${index}`,
          segments: [{ text: detail, dimColor: true }],
        }));
  const showDetailsBesideArt =
    showArt && resolvedDetailLines.length > 0 && columns >= width + 42;
  const version = process.env.CLOUDEVAL_CLI_VERSION ?? CLI_VERSION;

  return (
    <Box flexDirection="column" alignItems="flex-start" marginBottom={1}>
      {showArt ? (
        <>
          <Text color={bannerMetaColor()}>Welcome to</Text>
          <Box flexDirection="row" gap={2}>
            <Box flexDirection="column">
              {art.map((line, lineIndex) => (
                <BannerArtLine
                  key={line}
                  line={line}
                  lineIndex={lineIndex}
                  totalLines={art.length}
                />
              ))}
            </Box>
            {showDetailsBesideArt ? (
              <Box flexDirection="column" paddingTop={1}>
                <Text color={bannerMetaColor()}>CLI v{version}</Text>
                {resolvedDetailLines.map((line) => (
                  <BannerDetailText key={line.key} line={line} />
                ))}
              </Box>
            ) : null}
          </Box>
        </>
      ) : null}
      {!showDetailsBesideArt ? (
        <>
          <Text color={bannerMetaColor()}>CLI v{version}</Text>
          {resolvedDetailLines.map((line) => (
            <BannerDetailText key={line.key} line={line} />
          ))}
        </>
      ) : null}
    </Box>
  );
};
