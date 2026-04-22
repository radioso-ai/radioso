export const parseConfiguredSinks = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }

  return [...new Set(value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0))];
};

export const findInvalidConfiguredSinks = (value: string | undefined, allowed: readonly string[]): string[] => {
  const allowedSet = new Set(allowed.map((entry) => entry.toLowerCase()));
  return parseConfiguredSinks(value).filter((entry) => !allowedSet.has(entry));
};

export const hasConfiguredSink = (value: string | undefined, sinkName: string): boolean =>
  parseConfiguredSinks(value).includes(sinkName.toLowerCase());
