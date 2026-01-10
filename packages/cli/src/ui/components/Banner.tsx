import React from "react";
import { Box, Text } from "ink";

type BannerVariant = "auto" | "full" | "compact";

export interface BannerProps {
  disable?: boolean;
  variant?: BannerVariant;
}

const wordArt = [
  " ██████╗  ██╗       ██████╗  ██╗   ██╗ ██████╗  ███████╗ ██╗   ██╗  █████╗  ██╗     ",
  "██╔════╝  ██║      ██╔═══██╗ ██║   ██║ ██╔══██╗ ██╔════╝ ██║   ██║ ██╔══██╗ ██║     ",
  "██║       ██║      ██║   ██║ ██║   ██║ ██║  ██║ █████╗   ██║   ██║ ███████║ ██║     ",
  "██║       ██║      ██║   ██║ ██║   ██║ ██║  ██║ ██╔══╝   ╚██╗ ██╔╝ ██╔══██║ ██║     ",
  "╚██████╗  ███████╗ ╚██████╔╝ ╚██████╔╝ ██████╔╝ ███████╗  ╚████╔╝  ██║  ██║ ███████╗",
  " ╚═════╝  ╚══════╝  ╚═════╝   ╚═════╝  ╚═════╝  ╚══════╝   ╚═══╝   ╚═╝  ╚═╝ ╚══════╝",
];

const compactLines = ["Welcome to Cloudeval", "CLI version"];

const shouldUseColor = () =>
  !process.env.NO_COLOR && process.env.TERM !== "dumb";

const pickVariant = (variant: BannerVariant): "full" | "compact" => {
  if (variant === "compact") return "compact";
  if (variant === "full") return "full";
  
  // Always default to full for "auto" - only use compact if explicitly requested
  // or if terminal is extremely small
  const hasValidDimensions = 
    process.stdout.isTTY && 
    typeof process.stdout.columns === "number" && 
    typeof process.stdout.rows === "number" &&
    process.stdout.columns > 0 &&
    process.stdout.rows > 0;
  
  if (!hasValidDimensions) {
    // If we can't determine terminal size, default to full
    return "full";
  }
  
  const columns = process.stdout.columns;
  const rows = process.stdout.rows;
  
  // Only use compact if terminal is extremely small (less than 70 columns or 8 rows)
  // This ensures word art shows in most cases
  if (columns < 70 || rows < 8) {
    return "compact";
  }
  return "full";
};

export const Banner: React.FC<BannerProps> = ({
  disable = false,
  variant = "auto",
}) => {
  if (disable) return null;

  const useColor = shouldUseColor();
  const selected = pickVariant(variant);

  if (selected === "compact") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        {compactLines.map((line) => (
          <Text key={line} color={useColor ? "cyan" : undefined}>
            {line}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="row"
      justifyContent="flex-start"
      alignItems="flex-start"
      gap={3}
      marginBottom={1}
    >
      <Box flexDirection="column" gap={0}>
        <Box flexDirection="row" alignItems="flex-start" marginBottom={1}>
          <Text color={useColor ? "green" : undefined}>Welcome to</Text>
        </Box>
        {wordArt.map((line) => (
          <Text key={line} color={useColor ? "yellow" : undefined}>
            {line}
          </Text>
        ))}
        <Box flexDirection="row" justifyContent="flex-end" alignItems="flex-start" gap={3} marginBottom={0}>
          <Text color={useColor ? "green" : undefined}>CLI v{process.env.CLOUDEVAL_CLI_VERSION ?? "0.1.0"}</Text>
        </Box>
      </Box>
    </Box>
  );
};
