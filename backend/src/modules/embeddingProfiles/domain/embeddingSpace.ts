import { createHash } from "node:crypto";

import type {
  EmbeddingNormalization,
  EmbeddingProviderImplementation,
} from "../contracts/embeddingProvider.js";

export const MIN_EMBEDDING_DIMENSIONS = 1;
export const MAX_EMBEDDING_DIMENSIONS = 16_000;
export const MAX_EMBEDDING_MODEL_BYTES = 200;

type JsonPrimitive = boolean | number | string | null;
export type EmbeddingVectorOption =
  | JsonPrimitive
  | readonly EmbeddingVectorOption[]
  | { readonly [key: string]: EmbeddingVectorOption };

export interface EmbeddingSpaceIdentityInput {
  readonly providerImplementation: EmbeddingProviderImplementation;
  readonly endpointScopeFingerprint: string;
  readonly model: string;
  readonly dimensions: number;
  readonly distance: "cosine";
  readonly normalization: EmbeddingNormalization;
  readonly documentTask: string | null;
  readonly queryTask: string | null;
  readonly vectorOptions: Readonly<Record<string, EmbeddingVectorOption>>;
  readonly providerModelVersion: string | null;
}

export interface EmbeddingSpaceIdentity extends EmbeddingSpaceIdentityInput {
  readonly fingerprint: string;
}

const canonicalize = (value: EmbeddingVectorOption): EmbeddingVectorOption => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
};

const canonicalizeOptions = (
  value: Readonly<Record<string, EmbeddingVectorOption>>,
): Readonly<Record<string, EmbeddingVectorOption>> =>
  Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );

const requireNonEmpty = (value: string, field: string): string => {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must not be empty`);
  }
  return normalized;
};

export const createEmbeddingSpaceIdentity = (
  input: EmbeddingSpaceIdentityInput,
): EmbeddingSpaceIdentity => {
  if (
    !Number.isInteger(input.dimensions) ||
    input.dimensions < MIN_EMBEDDING_DIMENSIONS ||
    input.dimensions > MAX_EMBEDDING_DIMENSIONS
  ) {
    throw new Error(
      `dimensions must be an integer between ${MIN_EMBEDDING_DIMENSIONS} and ${MAX_EMBEDDING_DIMENSIONS}`,
    );
  }
  if (Buffer.byteLength(input.model, "utf8") > MAX_EMBEDDING_MODEL_BYTES) {
    throw new Error(`model must be at most ${MAX_EMBEDDING_MODEL_BYTES} UTF-8 bytes`);
  }

  const identity = {
    providerImplementation: input.providerImplementation,
    endpointScopeFingerprint: requireNonEmpty(
      input.endpointScopeFingerprint,
      "endpointScopeFingerprint",
    ),
    model: requireNonEmpty(input.model, "model"),
    dimensions: input.dimensions,
    distance: input.distance,
    normalization: input.normalization,
    documentTask: input.documentTask,
    queryTask: input.queryTask,
    vectorOptions: canonicalizeOptions(input.vectorOptions),
    providerModelVersion: input.providerModelVersion,
  } satisfies EmbeddingSpaceIdentityInput;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");

  return Object.freeze({ ...identity, fingerprint });
};

export const isEmbeddingSpaceCompatible = (
  left: Pick<EmbeddingSpaceIdentity, "fingerprint">,
  right: Pick<EmbeddingSpaceIdentity, "fingerprint">,
): boolean => left.fingerprint === right.fingerprint;
