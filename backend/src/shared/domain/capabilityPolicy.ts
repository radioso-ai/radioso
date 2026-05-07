export const capabilityNames = {
  assistant: {
    chat: "assistant.chat",
  },
  retrieval: {
    // Raw evidence retrieval surfaces: `/api/v1/retrieval/search` and `/api/v1/retrieval/answer`.
    search: "retrieval.search",
    answer: "retrieval.answer",
  },
  documents: {
    ingest: "documents.ingest",
    // Document management search surfaces, including document search history.
    search: "documents.search",
    delete: "documents.delete",
  },
  mcp: {
    describeCapabilities: "mcp.describe_capabilities",
  },
} as const;

type CapabilityGroupValue<T> = T extends Record<string, infer Value> ? Value : never;

export type CapabilityName = CapabilityGroupValue<(typeof capabilityNames)[keyof typeof capabilityNames]>;

const knownCapabilityNames = new Set<string>(
  Object.values(capabilityNames).flatMap((group) => Object.values(group)),
);

export interface CapabilityCheckInput {
  capability: CapabilityName | string;
  workspaceId?: string;
  accountId?: string;
  subjectId?: string;
}

export interface CapabilityDecision {
  allowed: boolean;
  reason?: string;
}

export interface CapabilityPolicy {
  can(input: CapabilityCheckInput): Promise<CapabilityDecision>;
}

export const assertKnownCapabilityName: (capability: string) => asserts capability is CapabilityName = (capability) => {
  if (!knownCapabilityNames.has(capability)) {
    throw new Error(`Unknown capability "${capability}"`);
  }
};

export class DefaultAllowCapabilityPolicy implements CapabilityPolicy {
  async can(input: CapabilityCheckInput): Promise<CapabilityDecision> {
    assertKnownCapabilityName(input.capability);
    return { allowed: true };
  }
}

export class StrictCapabilityPolicy implements CapabilityPolicy {
  private readonly deniedCapabilities: Set<string>;

  constructor(options: { deniedCapabilities: Array<CapabilityName | string> }) {
    this.deniedCapabilities = new Set(options.deniedCapabilities);
  }

  async can(input: CapabilityCheckInput): Promise<CapabilityDecision> {
    assertKnownCapabilityName(input.capability);
    if (this.deniedCapabilities.has(input.capability)) {
      return {
        allowed: false,
        reason: "capability_denied",
      };
    }
    return { allowed: true };
  }
}
