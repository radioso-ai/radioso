import type {
  EmbeddingSpaceRef,
} from "../contracts/embeddingConsumers.js";

const REQUIRED_FILTER_OPERATIONS = [
  "source",
  "metadata_containment",
  "retrieval_eligibility",
  "expiry",
] as const;

type ReadinessCheckpointStatus =
  | "building"
  | "ready"
  | "stale"
  | "unavailable"
  | "exact_fallback";

export interface EmbeddingProfileVectorCapabilities {
  readonly backend: string;
  readonly dimensionRanges: readonly {
    readonly min: number;
    readonly max: number;
  }[];
  readonly distanceMetrics: readonly string[];
  readonly filterOperations: readonly string[];
  readonly searchModes: readonly string[];
}

export interface EmbeddingProfileVectorCapabilitiesPort {
  getCapabilities(): Promise<EmbeddingProfileVectorCapabilities>;
}

export interface EmbeddingProfileReadinessState {
  readonly canonicalVectorCount: number;
  readonly requiredSequence: string;
  readonly checkpoint: {
    readonly acknowledgedSequence: string;
    readonly readiness: ReadinessCheckpointStatus;
  } | null;
}

export interface EmbeddingProfileReadinessStatePort {
  inspect(input: {
    readonly backendKey: string;
    readonly workspaceId: string;
    readonly embeddingSpaceId: string;
  }): Promise<EmbeddingProfileReadinessState>;
}

export interface EmbeddingIndexQualificationManifest {
  /**
   * Stable identifier for committed benchmark evidence. It is diagnostic
   * metadata, not a selectable route or a runtime-generated claim.
   */
  readonly evidenceId: string;
  readonly exactSearch: readonly {
    readonly backend: string;
    readonly minDimensions: number;
    readonly maxDimensions: number;
    readonly maxCorpusVectors: number;
  }[];
  readonly acceleratedSearch: readonly {
    readonly backend: string;
    readonly minDimensions: number;
    readonly maxDimensions: number;
  }[];
}

export type EmbeddingProfileIndexReadiness =
  | "accelerated"
  | "exact_fallback"
  | "building"
  | "stale"
  | "unavailable";

export type EmbeddingProfileActivationBlockReason =
  | "unsupported_embedding_space"
  | "checkpoint_missing"
  | "projection_lag"
  | "checkpoint_stale"
  | "backend_unavailable"
  | "accelerated_index_building"
  | "exact_route_unqualified"
  | "exact_corpus_limit_exceeded";

export interface EmbeddingProfileReadiness {
  readonly readiness: EmbeddingProfileIndexReadiness;
  readonly route: "exact" | "accelerated" | null;
  readonly activationAllowed: boolean;
  readonly activationBlockReason: EmbeddingProfileActivationBlockReason | null;
  readonly canonicalVectorCount: number;
  readonly requiredSequence: string;
  readonly acknowledgedSequence: string | null;
  readonly projectionLag: string;
  readonly qualificationEvidenceId: string;
}

export class EmbeddingProfileReadinessError extends Error {
  constructor(readonly code: EmbeddingProfileActivationBlockReason) {
    super(code);
    this.name = "EmbeddingProfileReadinessError";
  }
}

export class EmbeddingProfileReadinessService {
  constructor(
    private readonly dependencies: {
      readonly capabilities: EmbeddingProfileVectorCapabilitiesPort;
      readonly state: EmbeddingProfileReadinessStatePort;
      readonly qualification: EmbeddingIndexQualificationManifest;
    },
  ) {
    assertQualificationManifest(dependencies.qualification);
  }

  async evaluate(input: {
    readonly backendKey: string;
    readonly workspaceId: string;
    readonly space: EmbeddingSpaceRef;
  }): Promise<EmbeddingProfileReadiness> {
    const capabilities = await this.dependencies.capabilities.getCapabilities();
    const state = await this.dependencies.state.inspect({
      backendKey: input.backendKey,
      workspaceId: input.workspaceId,
      embeddingSpaceId: input.space.id,
    });
    assertReadinessState(state);

    const base = readinessBase(state, this.dependencies.qualification.evidenceId);
    if (!supportsRequiredContract(capabilities, input.backendKey, input.space)) {
      return blocked(base, "unavailable", "unsupported_embedding_space");
    }

    const checkpoint = state.checkpoint;
    if (!checkpoint) {
      return blocked(base, "building", "checkpoint_missing");
    }
    if (checkpoint.readiness === "unavailable") {
      return blocked(base, "unavailable", "backend_unavailable");
    }
    if (checkpoint.readiness === "stale") {
      return blocked(base, "stale", "checkpoint_stale");
    }

    const projectionLag = calculateProjectionLag(
      state.requiredSequence,
      checkpoint.acknowledgedSequence,
    );
    const withLag = {
      ...base,
      acknowledgedSequence: checkpoint.acknowledgedSequence,
      projectionLag,
    };
    if (projectionLag !== "0") {
      return blocked(
        withLag,
        checkpoint.readiness === "building" ? "building" : "stale",
        "projection_lag",
      );
    }

    const acceleratedQualified =
      capabilities.searchModes.includes("accelerated")
      && matchesAcceleratedQualification(
        this.dependencies.qualification,
        capabilities.backend,
        input.space.dimensions,
      );
    const exactLimit = capabilities.searchModes.includes("exact")
      ? findExactLimit(
          this.dependencies.qualification,
          capabilities.backend,
          input.space.dimensions,
        )
      : null;
    const exactSafe =
      exactLimit !== null
      && state.canonicalVectorCount <= exactLimit;

    if (checkpoint.readiness === "ready" && acceleratedQualified) {
      return allowed(withLag, "accelerated", "accelerated");
    }
    if (exactSafe) {
      return allowed(withLag, "exact_fallback", "exact");
    }
    if (exactLimit === null) {
      return blocked(withLag, "unavailable", "exact_route_unqualified");
    }
    if (
      acceleratedQualified
      && checkpoint.readiness === "building"
    ) {
      return blocked(
        withLag,
        "building",
        "accelerated_index_building",
      );
    }
    return blocked(
      withLag,
      "unavailable",
      "exact_corpus_limit_exceeded",
    );
  }

  assertActivationAllowed(
    readiness: EmbeddingProfileReadiness,
  ): void {
    if (!readiness.activationAllowed) {
      throw new EmbeddingProfileReadinessError(
        readiness.activationBlockReason!,
      );
    }
  }
}

type ReadinessBase = Omit<
  EmbeddingProfileReadiness,
  | "readiness"
  | "route"
  | "activationAllowed"
  | "activationBlockReason"
>;

const readinessBase = (
  state: EmbeddingProfileReadinessState,
  evidenceId: string,
): ReadinessBase => ({
  canonicalVectorCount: state.canonicalVectorCount,
  requiredSequence: state.requiredSequence,
  acknowledgedSequence: state.checkpoint?.acknowledgedSequence ?? null,
  projectionLag: state.checkpoint
    ? calculateProjectionLag(
        state.requiredSequence,
        state.checkpoint.acknowledgedSequence,
      )
    : state.requiredSequence,
  qualificationEvidenceId: evidenceId,
});

const allowed = (
  base: ReadinessBase,
  readiness: "accelerated" | "exact_fallback",
  route: "accelerated" | "exact",
): EmbeddingProfileReadiness => ({
  ...base,
  readiness,
  route,
  activationAllowed: true,
  activationBlockReason: null,
});

const blocked = (
  base: ReadinessBase,
  readiness: "building" | "stale" | "unavailable",
  reason: EmbeddingProfileActivationBlockReason,
): EmbeddingProfileReadiness => ({
  ...base,
  readiness,
  route: null,
  activationAllowed: false,
  activationBlockReason: reason,
});

const supportsRequiredContract = (
  capabilities: EmbeddingProfileVectorCapabilities,
  backendKey: string,
  space: EmbeddingSpaceRef,
): boolean =>
  capabilities.backend === backendKey
  && space.distanceMetric === "cosine"
  && capabilities.distanceMetrics.includes("cosine")
  && capabilities.dimensionRanges.some(
    ({ min, max }) =>
      Number.isInteger(space.dimensions)
      && space.dimensions >= min
      && space.dimensions <= max,
  )
  && REQUIRED_FILTER_OPERATIONS.every((operation) =>
    capabilities.filterOperations.includes(operation));

const matchesAcceleratedQualification = (
  manifest: EmbeddingIndexQualificationManifest,
  backend: string,
  dimensions: number,
): boolean =>
  manifest.acceleratedSearch.some((qualification) =>
    qualification.backend === backend
    && dimensions >= qualification.minDimensions
    && dimensions <= qualification.maxDimensions);

const findExactLimit = (
  manifest: EmbeddingIndexQualificationManifest,
  backend: string,
  dimensions: number,
): number | null => {
  const matches = manifest.exactSearch
    .filter((qualification) =>
      qualification.backend === backend
      && dimensions >= qualification.minDimensions
      && dimensions <= qualification.maxDimensions)
    .map(({ maxCorpusVectors }) => maxCorpusVectors);
  return matches.length > 0 ? Math.min(...matches) : null;
};

const calculateProjectionLag = (
  requiredSequence: string,
  acknowledgedSequence: string,
): string => {
  const required = BigInt(requiredSequence);
  const acknowledged = BigInt(acknowledgedSequence);
  return (required > acknowledged ? required - acknowledged : 0n).toString();
};

const assertReadinessState = (
  state: EmbeddingProfileReadinessState,
): void => {
  if (
    !Number.isSafeInteger(state.canonicalVectorCount)
    || state.canonicalVectorCount < 0
    || !isUnsignedDecimal(state.requiredSequence)
    || (
      state.checkpoint !== null
      && !isUnsignedDecimal(state.checkpoint.acknowledgedSequence)
    )
  ) {
    throw new Error("invalid_embedding_readiness_snapshot");
  }
};

const assertQualificationManifest = (
  manifest: EmbeddingIndexQualificationManifest,
): void => {
  const validRange = (range: {
    minDimensions: number;
    maxDimensions: number;
  }): boolean =>
    Number.isInteger(range.minDimensions)
    && range.minDimensions > 0
    && Number.isInteger(range.maxDimensions)
    && range.maxDimensions >= range.minDimensions;
  const valid =
    manifest.evidenceId.trim().length > 0
    && manifest.exactSearch.every((qualification) =>
      qualification.backend.trim().length > 0
      && validRange(qualification)
      && Number.isSafeInteger(qualification.maxCorpusVectors)
      && qualification.maxCorpusVectors >= 0)
    && manifest.acceleratedSearch.every((qualification) =>
      qualification.backend.trim().length > 0
      && validRange(qualification));
  if (!valid) {
    throw new Error("invalid_embedding_index_qualification");
  }
};

const isUnsignedDecimal = (value: string): boolean =>
  /^(0|[1-9]\d*)$/.test(value);
