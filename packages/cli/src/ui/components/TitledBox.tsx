import React from "react";
import { Box, Text } from "ink";
import { terminalTheme } from "../theme.js";

type BoxComponentProps = React.ComponentProps<typeof Box>;

type TitledBoxProps = Omit<BoxComponentProps, "title"> & {
  title: string;
  titleColor?: string;
};

export const TitledBox: React.FC<TitledBoxProps> = ({
  title,
  titleColor,
  children,
  borderStyle = "round",
  borderColor = terminalTheme.muted,
  flexDirection = "column",
  padding = 1,
  marginTop,
  marginBottom,
  marginLeft,
  marginRight,
  marginX,
  marginY,
  gap,
  rowGap,
  columnGap,
  alignItems,
  justifyContent,
  flexWrap,
  ...boxProps
}) => {
  const labelColor =
    titleColor ?? (typeof borderColor === "string" ? borderColor : undefined);

  return (
    <Box
      {...boxProps}
      flexDirection="column"
      borderStyle={borderStyle}
      borderColor={borderColor}
      padding={padding}
      marginTop={marginTop}
      marginBottom={marginBottom}
      marginLeft={marginLeft}
      marginRight={marginRight}
      marginX={marginX}
      marginY={marginY}
    >
      <Box position="absolute" marginLeft={2} marginTop={-1}>
        <Text bold color={labelColor}>
          {" "}
          {title}
          {" "}
        </Text>
      </Box>
      <Box
        flexDirection={flexDirection}
        gap={gap}
        rowGap={rowGap}
        columnGap={columnGap}
        alignItems={alignItems}
        justifyContent={justifyContent}
        flexWrap={flexWrap}
      >
        {children}
      </Box>
    </Box>
  );
};
