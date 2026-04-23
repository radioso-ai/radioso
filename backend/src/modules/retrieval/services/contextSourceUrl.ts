export const resolveContextSourceUrl = (metadata?: Record<string, unknown>): string | undefined => {
  if (!metadata) {
    return undefined;
  }

  if (typeof metadata.sourceUrl === "string" && metadata.sourceUrl.trim().length > 0) {
    return metadata.sourceUrl;
  }

  if (typeof metadata.url === "string" && metadata.url.trim().length > 0) {
    return metadata.url;
  }

  const parsedData = metadata.parsedData;
  if (
    parsedData &&
    typeof parsedData === "object" &&
    "url" in parsedData &&
    typeof parsedData.url === "string" &&
    parsedData.url.trim().length > 0
  ) {
    return parsedData.url;
  }

  return undefined;
};
