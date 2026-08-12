import { beforeEach, describe, expect, it, vi } from "vitest";

const { constructedWithRecorder, constructedRewriteWithRecorder } = vi.hoisted(() => ({
  constructedWithRecorder: vi.fn(),
  constructedRewriteWithRecorder: vi.fn(),
}));

vi.mock("../../../src/shared/infra/llm/contextualGateways.js", () => ({
  ContextualStructuredInferenceFactory: class {
    constructor(_deps: unknown, recorder: unknown) {
      constructedWithRecorder(recorder);
    }
  },
  createRewriteTierStructuredInferenceFactory: (_deps: unknown, recorder: unknown) => {
    constructedRewriteWithRecorder(recorder);
    return { create: vi.fn() };
  },
}));

import { buildAudiencePulseService } from "../../../src/app/server/builders/audiencePulse.js";
import type { UsageEventRecorder } from "../../../src/shared/domain/usageEventRecorder.js";

const builderInput = (recorder: UsageEventRecorder) =>
  ({
    kysely: {},
    llmCapabilityResolver: {},
    usageEventRecorder: recorder,
    usageLimitPolicy: {},
    auditService: {},
    logger: {},
    telemetryService: { emit: vi.fn().mockResolvedValue(undefined) },
    abuseControlService: {},
    embeddingBindingResolver: {},
  }) as unknown as Parameters<typeof buildAudiencePulseService>[0];

describe("Audience Pulse service assembly", () => {
  beforeEach(() => {
    constructedWithRecorder.mockClear();
    constructedRewriteWithRecorder.mockClear();
  });

  it("threads the app usage recorder into the analysis and naming inference factories", () => {
    const recorder: UsageEventRecorder = {
      async recordEmbedding() {},
      async recordModelCall() {},
    };

    buildAudiencePulseService(builderInput(recorder));

    // Once for the service's own analysis call, once for census topic naming.
    expect(constructedWithRecorder).toHaveBeenCalledTimes(2);
    expect(constructedWithRecorder).toHaveBeenCalledWith(recorder);
  });

  it("wires the privacy audit as the only cheap-tier call, with the recorder", () => {
    const recorder: UsageEventRecorder = {
      async recordEmbedding() {},
      async recordModelCall() {},
    };

    buildAudiencePulseService(builderInput(recorder));

    expect(constructedRewriteWithRecorder).toHaveBeenCalledTimes(1);
    expect(constructedRewriteWithRecorder).toHaveBeenCalledWith(recorder);
  });
});
