export interface AutoScrollInput {
  currentOffset: number;
  previousContentHeight: number;
  viewportHeight: number;
  suppressNextAutoScroll: boolean;
  threshold?: number;
}

export const shouldAutoScrollToBottom = ({
  currentOffset,
  previousContentHeight,
  viewportHeight,
  suppressNextAutoScroll,
  threshold = 2,
}: AutoScrollInput): boolean => {
  if (suppressNextAutoScroll) {
    return false;
  }

  const previousMaxOffset = Math.max(0, previousContentHeight - viewportHeight);
  return currentOffset >= previousMaxOffset - threshold;
};
