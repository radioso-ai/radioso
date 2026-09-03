/**
 * Provider failure shapes are mail-transport knowledge, so callers that only need to log a
 * delivery failure read them through here instead of re-deriving the driver's error contract.
 */

export const readMailProviderStatusCode = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object" || !("statusCode" in error)) {
    return undefined;
  }
  const statusCode = error.statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
};

export const readMailProviderErrorName = (error: unknown): string | undefined => {
  if (!error || typeof error !== "object" || !("providerErrorName" in error)) {
    return undefined;
  }
  const providerErrorName = error.providerErrorName;
  return typeof providerErrorName === "string" && providerErrorName.length > 0
    ? providerErrorName
    : undefined;
};

export const readMailErrorClass = (error: unknown): string =>
  error instanceof Error ? error.name : typeof error;
