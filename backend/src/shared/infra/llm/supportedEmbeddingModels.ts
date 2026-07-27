import type {
  EmbeddingProviderImplementation,
  SupportedEmbeddingModelDescriptor,
} from "../../../modules/embeddingProfiles/contracts/embeddingProvider.js";

export const supportedEmbeddingModelIds = [
  "text-embedding-3-small",
  "text-embedding-3-large",
  "text-embedding-ada-002",
  "gemini-embedding-001",
] as const;

export type SupportedEmbeddingModelId =
  (typeof supportedEmbeddingModelIds)[number];

const OPENAI_TASKS = {
  retrieval_document: null,
  retrieval_query: null,
  clustering: null,
} as const;

const GEMINI_TASKS = {
  retrieval_document: "RETRIEVAL_DOCUMENT",
  retrieval_query: "RETRIEVAL_QUERY",
  clustering: "CLUSTERING",
} as const;

const COMMON_LIMITS = {
  maxBatch: 256,
  maxInputBytes: 1_048_576,
  maxResponseBytes: 8_388_608,
} as const;

const descriptors = {
  "text-embedding-3-small": {
    model: "text-embedding-3-small",
    providerFamily: "openai_like",
    dimensions: 1536,
    normalization: "provider_unit",
    taskMapping: OPENAI_TASKS,
    limits: COMMON_LIMITS,
  },
  "text-embedding-3-large": {
    model: "text-embedding-3-large",
    providerFamily: "openai_like",
    dimensions: 3072,
    normalization: "provider_unit",
    taskMapping: OPENAI_TASKS,
    limits: COMMON_LIMITS,
  },
  "text-embedding-ada-002": {
    model: "text-embedding-ada-002",
    providerFamily: "openai_like",
    dimensions: 1536,
    normalization: "provider_unit",
    taskMapping: OPENAI_TASKS,
    limits: COMMON_LIMITS,
  },
  "gemini-embedding-001": {
    model: "gemini-embedding-001",
    providerFamily: "gemini",
    dimensions: 3072,
    normalization: "provider_unit",
    taskMapping: GEMINI_TASKS,
    limits: {
      ...COMMON_LIMITS,
      maxBatch: 1,
    },
  },
} as const satisfies Record<
  SupportedEmbeddingModelId,
  SupportedEmbeddingModelDescriptor
>;

const EXISTING_GEMINI_1536_DESCRIPTOR: SupportedEmbeddingModelDescriptor = {
  model: "gemini-embedding-001",
  providerFamily: "gemini",
  dimensions: 1536,
  normalization: "application_unit",
  taskMapping: OPENAI_TASKS,
  limits: {
    ...COMMON_LIMITS,
    maxBatch: 1,
  },
};

export const isSupportedEmbeddingModel = (
  model: string,
): model is SupportedEmbeddingModelId =>
  supportedEmbeddingModelIds.includes(model as SupportedEmbeddingModelId);

export const getSupportedEmbeddingModel = (
  model: string,
): SupportedEmbeddingModelDescriptor => {
  if (!isSupportedEmbeddingModel(model)) {
    throw new Error(`Unsupported embedding model: ${model}`);
  }
  return descriptors[model];
};

export const resolveEmbeddingModelDescriptor = (
  model: string,
  existingBinding: {
    readonly provider: EmbeddingProviderImplementation;
    readonly dimensions: number;
  },
): SupportedEmbeddingModelDescriptor => {
  if (
    !Number.isInteger(existingBinding.dimensions)
    || existingBinding.dimensions < 1
    || existingBinding.dimensions > 16_000
  ) {
    throw new Error("Existing embedding dimensions must be an integer between 1 and 16000");
  }
  if (
    model === "gemini-embedding-001"
    && existingBinding.provider === "gemini"
    && existingBinding.dimensions === EXISTING_GEMINI_1536_DESCRIPTOR.dimensions
  ) {
    return EXISTING_GEMINI_1536_DESCRIPTOR;
  }
  if (isSupportedEmbeddingModel(model)) {
    return descriptors[model];
  }
  const gemini = existingBinding.provider === "gemini";
  return {
    model,
    providerFamily: gemini ? "gemini" : "openai_like",
    dimensions: existingBinding.dimensions,
    normalization: "application_unit",
    taskMapping: OPENAI_TASKS,
    limits: gemini ? { ...COMMON_LIMITS, maxBatch: 1 } : COMMON_LIMITS,
  };
};
