/** Normalize optional text from persistence at a nullable contract boundary. */
export const normalizeNullableText = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};
