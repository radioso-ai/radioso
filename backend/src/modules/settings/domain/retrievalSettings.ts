import { badRequest } from "../../../shared/domain/errors.js";

export type RetrievalSignalKey = string;
export const METADATA_SIGNAL_PREFIX = "metadata.";

export const signalPolicyModes = ["boost_only", "hard_filter"] as const;
export type SignalPolicyMode = (typeof signalPolicyModes)[number];

export interface RetrievalSignalDefinition {
  key: RetrievalSignalKey;
  label: string;
  description: string;
  source: "system" | "metadata";
}

export const builtInRetrievalSignalDefinitions: RetrievalSignalDefinition[] = [];

export const retrievalSignalDefinitions = builtInRetrievalSignalDefinitions;

export interface RetrievalSignalPolicy {
  signalKey: RetrievalSignalKey;
  enabled: boolean;
  mode: SignalPolicyMode;
}

interface LegacyAttributeControl {
  family?: string;
  enabled?: boolean;
  mode?: string;
}

const legacyFamilyToSignalKey: Record<string, RetrievalSignalKey> = {
  date_point: "document_date",
  date_range: "document_period",
  money_value: "document_amount",
  location: "document_location",
};

export const isMetadataSignalKey = (signalKey: string): signalKey is `${typeof METADATA_SIGNAL_PREFIX}${string}` =>
  signalKey.startsWith(METADATA_SIGNAL_PREFIX) && signalKey.length > METADATA_SIGNAL_PREFIX.length;

export const metadataPathFromSignalKey = (signalKey: string): string | null =>
  isMetadataSignalKey(signalKey) ? signalKey.slice(METADATA_SIGNAL_PREFIX.length) : null;

const humanizeMetadataPath = (path: string): string =>
  path
    .split(".")
    .map((segment) =>
      segment
        .replace(/[_-]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .trim(),
    )
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" / ");

export const buildMetadataSignalDefinition = (path: string): RetrievalSignalDefinition => {
  const normalizedPath = path.trim();

  return {
    key: `${METADATA_SIGNAL_PREFIX}${normalizedPath}`,
    label: humanizeMetadataPath(normalizedPath),
    description: `Use explicit ${normalizedPath} metadata matches such as ${normalizedPath}:value in retrieval queries.`,
    source: "metadata",
  };
};

export const definitionForSignalKey = (signalKey: string): RetrievalSignalDefinition | null => {
  const metadataPath = metadataPathFromSignalKey(signalKey);
  return metadataPath ? buildMetadataSignalDefinition(metadataPath) : null;
};

export const mergeSignalDefinitions = (...groups: RetrievalSignalDefinition[][]): RetrievalSignalDefinition[] => {
  const merged = new Map<string, RetrievalSignalDefinition>();

  for (const group of groups) {
    for (const definition of group) {
      if (!merged.has(definition.key)) {
        merged.set(definition.key, definition);
      }
    }
  }

  return [...merged.values()];
};

export const definitionsFromPolicies = (
  policies: Array<Pick<RetrievalSignalPolicy, "signalKey">>,
): RetrievalSignalDefinition[] =>
  mergeSignalDefinitions(
    policies
      .map((policy) => definitionForSignalKey(policy.signalKey))
      .filter((definition): definition is RetrievalSignalDefinition => definition !== null),
  );

const isSupportedSignalKey = (signalKey: string): boolean => isMetadataSignalKey(signalKey);

const defaultPolicyForDefinition = (definition: RetrievalSignalDefinition): RetrievalSignalPolicy => ({
  signalKey: definition.key,
  enabled: false,
  mode: "boost_only",
});

export interface RetrievalSettingsRecord {
  workspaceId: string;
  queryRewriteEnabled: boolean;
  rerankEnabled: boolean;
  vectorTopK: number;
  similarityThreshold: number;
  rerankTopK: number;
  warmthLevel: number;
  citationDisplayEnabled: boolean;
  signalPolicies: RetrievalSignalPolicy[];
  customInstruction: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RetrievalSettingsInput {
  queryRewriteEnabled: boolean;
  rerankEnabled: boolean;
  vectorTopK: number;
  similarityThreshold: number;
  rerankTopK: number;
  warmthLevel: number;
  citationDisplayEnabled: boolean;
  signalPolicies: RetrievalSignalPolicy[];
  customInstruction: string;
}

export const defaultSignalPolicies = (
  signalDefinitions: RetrievalSignalDefinition[] = builtInRetrievalSignalDefinitions,
): RetrievalSignalPolicy[] => signalDefinitions.map(defaultPolicyForDefinition);

export const defaultAttributeControls = (): RetrievalSignalPolicy[] => [
  { signalKey: "document_date", enabled: true, mode: "boost_only" },
  { signalKey: "document_period", enabled: true, mode: "boost_only" },
  { signalKey: "document_amount", enabled: true, mode: "boost_only" },
  { signalKey: "document_location", enabled: true, mode: "boost_only" },
];

export const defaultRetrievalSettings = (
  workspaceId: string,
  signalDefinitions: RetrievalSignalDefinition[] = builtInRetrievalSignalDefinitions,
): RetrievalSettingsRecord => ({
  workspaceId,
  queryRewriteEnabled: false,
  rerankEnabled: false,
  vectorTopK: 15,
  similarityThreshold: 0.2,
  rerankTopK: 5,
  warmthLevel: 5,
  citationDisplayEnabled: true,
  signalPolicies: defaultSignalPolicies(signalDefinitions),
  customInstruction: "",
  createdAt: new Date(),
  updatedAt: new Date(),
});

export const normalizeSignalPolicies = (
  value: unknown,
  signalDefinitions: RetrievalSignalDefinition[] = builtInRetrievalSignalDefinitions,
): RetrievalSignalPolicy[] => {
  const supportedDefinitions = mergeSignalDefinitions(
    signalDefinitions,
    Array.isArray(value)
      ? definitionsFromPolicies(
          value
            .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
            .map((entry) => ({
              signalKey:
                typeof entry.signalKey === "string"
                  ? entry.signalKey
                  : typeof (entry as LegacyAttributeControl).family === "string"
                    ? legacyFamilyToSignalKey[(entry as LegacyAttributeControl).family ?? ""] ?? ""
                    : "",
            }))
            .filter((entry) => entry.signalKey.length > 0),
        )
      : [],
  );

  if (!Array.isArray(value)) {
    return defaultSignalPolicies(supportedDefinitions);
  }

  const normalizedByKey = new Map<RetrievalSignalKey, RetrievalSignalPolicy>();

  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const candidate = entry as Record<string, unknown> & LegacyAttributeControl;
    const signalKeyValue =
      typeof candidate.signalKey === "string"
        ? candidate.signalKey
        : typeof candidate.family === "string"
          ? legacyFamilyToSignalKey[candidate.family] ?? null
          : null;

    if (!signalKeyValue || !isSupportedSignalKey(signalKeyValue)) {
      continue;
    }

    normalizedByKey.set(signalKeyValue, {
      signalKey: signalKeyValue,
      enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : defaultPolicyForDefinition(definitionForSignalKey(signalKeyValue)!).enabled,
      mode: signalPolicyModes.includes(candidate.mode as SignalPolicyMode)
        ? (candidate.mode as SignalPolicyMode)
        : "boost_only",
    });
  }

  return supportedDefinitions.map(
    (definition) => normalizedByKey.get(definition.key) ?? defaultPolicyForDefinition(definition),
  );
};

export const validateRetrievalSettings = (
  input: RetrievalSettingsInput,
  signalDefinitions: RetrievalSignalDefinition[] = builtInRetrievalSignalDefinitions,
): RetrievalSettingsInput => {
  if (input.vectorTopK < 1 || input.vectorTopK > 300) {
    throw badRequest("vectorTopK must be between 1 and 300");
  }
  if (input.similarityThreshold < 0 || input.similarityThreshold > 1) {
    throw badRequest("similarityThreshold must be between 0 and 1");
  }
  if (input.rerankTopK < 1) {
    throw badRequest("rerankTopK must be greater than 0");
  }
  if (!Number.isInteger(input.warmthLevel) || input.warmthLevel < 1 || input.warmthLevel > 10) {
    throw badRequest("warmthLevel must be between 1 and 10");
  }
  if (!Array.isArray(input.signalPolicies)) {
    throw badRequest("signalPolicies must be an array");
  }

  const supportedDefinitions = mergeSignalDefinitions(signalDefinitions, definitionsFromPolicies(input.signalPolicies));
  const supportedSignalKeys = new Set(supportedDefinitions.map((definition) => definition.key));
  const seenSignals = new Set<string>();

  for (const policy of input.signalPolicies) {
    if (!isSupportedSignalKey(policy.signalKey) || !supportedSignalKeys.has(policy.signalKey)) {
      throw badRequest("signalPolicies signalKey must be supported");
    }
    if (seenSignals.has(policy.signalKey)) {
      throw badRequest("signalPolicies must not contain duplicate signal keys");
    }
    if (!signalPolicyModes.includes(policy.mode)) {
      throw badRequest("signalPolicies mode must be supported");
    }
    if (typeof policy.enabled !== "boolean") {
      throw badRequest("signalPolicies enabled must be a boolean");
    }

    seenSignals.add(policy.signalKey);
  }

  if (seenSignals.size !== supportedSignalKeys.size) {
    throw badRequest("signalPolicies must include every supported signal");
  }

  if (typeof input.customInstruction !== "string") {
    throw badRequest("customInstruction must be a string");
  }
  if (input.customInstruction.length > 2000) {
    throw badRequest("customInstruction must not exceed 2000 characters");
  }

  return input;
};
