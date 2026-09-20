import type { CacheAccounting, ReusableInputBoundary } from "./providerTypes.js";

interface ReusableInputBoundaryInput {
  stableSystemPrefix: unknown;
  dynamicSystemSuffix?: unknown;
}

interface CacheAccountingInput {
  readInputTokens?: unknown;
  writeInputTokens?: unknown;
}

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Boundary metadata is optional optimization data. Invalid values are ignored so
 * they cannot reject or alter the compatible request rendering.
 */
export const createReusableInputBoundary = (
  input: ReusableInputBoundaryInput | undefined,
): ReusableInputBoundary | undefined => {
  if (!input || typeof input.stableSystemPrefix !== "string" || input.stableSystemPrefix.length === 0) {
    return undefined;
  }
  if (input.dynamicSystemSuffix !== undefined && typeof input.dynamicSystemSuffix !== "string") {
    return undefined;
  }
  return {
    stableSystemPrefix: input.stableSystemPrefix,
    dynamicSystemSuffix: input.dynamicSystemSuffix ?? "",
  };
};

const isReusableInputBoundary = (value: unknown): value is ReusableInputBoundary =>
  Boolean(createReusableInputBoundary(value as ReusableInputBoundaryInput));

export const renderSystemPromptWithReusableInputBoundary = (boundary: ReusableInputBoundary): string =>
  `${boundary.stableSystemPrefix}${boundary.dynamicSystemSuffix}`;

export const reusableInputBoundaryMatchesSystemPrompt = (
  boundary: unknown,
  systemPrompt: string | undefined,
): boundary is ReusableInputBoundary =>
  isReusableInputBoundary(boundary)
  && systemPrompt === renderSystemPromptWithReusableInputBoundary(boundary);

export const normalizeCacheAccounting = (input: CacheAccountingInput): CacheAccounting => {
  const readInputTokens = finiteNonNegative(input.readInputTokens) ? input.readInputTokens : undefined;
  const writeInputTokens = finiteNonNegative(input.writeInputTokens) ? input.writeInputTokens : undefined;
  if (readInputTokens === undefined && writeInputTokens === undefined) {
    return { state: "unknown" };
  }
  return {
    state: "reported",
    ...(readInputTokens === undefined ? {} : { readInputTokens }),
    ...(writeInputTokens === undefined ? {} : { writeInputTokens }),
  };
};
