export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const getString = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" ? value : null;
};

export const recordFromUnknown = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) {
    return value;
  }
  return { value };
};
