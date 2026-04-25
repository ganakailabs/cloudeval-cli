import React from "react";
import { Box, Text } from "ink";
import { terminalTheme } from "../theme.js";

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

const compactWordArt = [
  "  ____ _                 _ _____           _ ",
  " / ___| | ___  _   _  __| | ____|_   ____ _| |",
  "| |   | |/ _ \\| | | |/ _` |  _| \\ \\ / / _` | |",
  "| |___| | (_) | |_| | (_| | |___ \\ V / (_| | |",
  " \\____|_|\\___/ \\__,_|\\__,_|_____| \\_/ \\__,_|_|",
];

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

  const selected = pickVariant(variant);
  const version = process.env.CLOUDEVAL_CLI_VERSION ?? "0.1.0";

  if (selected === "compact") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={terminalTheme.success}>Welcome to</Text>
        {compactWordArt.map((line) => (
          <Text key={line} color={terminalTheme.accent}>
            {line}
          </Text>
        ))}
        <Text color={terminalTheme.success}>CLI v{version}</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      alignItems="flex-start"
      marginBottom={1}
    >
      <Text color={terminalTheme.success}>Welcome to</Text>
      {wordArt.map((line) => (
        <Text key={line} color={terminalTheme.accent}>
          {line}
        </Text>
      ))}
      <Box width={90} flexDirection="row" justifyContent="flex-end">
        <Text color={terminalTheme.success}>CLI v{version}</Text>
      </Box>
    </Box>
  );
};
