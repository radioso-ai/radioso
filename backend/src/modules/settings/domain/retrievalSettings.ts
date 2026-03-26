import { badRequest } from "../../../shared/domain/errors.js";

export const retrievalSignalKeys = [
  "document_date",
  "document_period",
  "document_amount",
  "document_location",
] as const;
export type RetrievalSignalKey = (typeof retrievalSignalKeys)[number];

export const signalPolicyModes = ["boost_only", "hard_filter"] as const;
export type SignalPolicyMode = (typeof signalPolicyModes)[number];

export interface RetrievalSignalDefinition {
  key: RetrievalSignalKey;
  label: string;
  description: string;
}

export const retrievalSignalDefinitions: RetrievalSignalDefinition[] = [
  {
    key: "document_date",
    label: "Document date",
    description: "Use exact dates such as effective days, deadlines, or dated entries.",
  },
  {
    key: "document_period",
    label: "Document period",
    description: "Use spans such as validity windows, booking periods, or event ranges.",
  },
  {
    key: "document_amount",
    label: "Document amount",
    description: "Use numeric amounts such as prices, fees, or budget thresholds.",
  },
  {
    key: "document_location",
    label: "Document location",
    description: "Use place references such as cities, countries, or venues.",
  },
];

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

export const defaultSignalPolicies = (): RetrievalSignalPolicy[] =>
  retrievalSignalKeys.map((signalKey) => ({
    signalKey,
    enabled: true,
    mode: "boost_only",
  }));

export const defaultAttributeControls = defaultSignalPolicies;

export const defaultRetrievalSettings = (workspaceId: string): RetrievalSettingsRecord => ({
  workspaceId,
  queryRewriteEnabled: false,
  rerankEnabled: false,
  vectorTopK: 15,
  similarityThreshold: 0.2,
  rerankTopK: 5,
  warmthLevel: 5,
  citationDisplayEnabled: true,
  signalPolicies: defaultSignalPolicies(),
  customInstruction: "",
  createdAt: new Date(),
  updatedAt: new Date(),
});

export const normalizeSignalPolicies = (value: unknown): RetrievalSignalPolicy[] => {
  if (!Array.isArray(value)) {
    return defaultSignalPolicies();
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

    if (!signalKeyValue || !retrievalSignalKeys.includes(signalKeyValue as RetrievalSignalKey)) {
      continue;
    }

    const signalKey = signalKeyValue as RetrievalSignalKey;
    normalizedByKey.set(signalKey, {
      signalKey,
      enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : true,
      mode: signalPolicyModes.includes(candidate.mode as SignalPolicyMode)
        ? (candidate.mode as SignalPolicyMode)
        : "boost_only",
    });
  }

  return retrievalSignalKeys.map(
    (signalKey) =>
      normalizedByKey.get(signalKey) ?? {
        signalKey,
        enabled: true,
        mode: "boost_only",
      },
  );
};

export const validateRetrievalSettings = (input: RetrievalSettingsInput): RetrievalSettingsInput => {
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

  const seenSignals = new Set<string>();
  for (const policy of input.signalPolicies) {
    if (!retrievalSignalKeys.includes(policy.signalKey)) {
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

  if (seenSignals.size !== retrievalSignalKeys.length) {
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
