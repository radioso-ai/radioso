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

import {
  ApplicationModuleCoordinator,
  createApplicationExtensionRegistry,
} from "../../../src/app/composition/applicationModule.js";
import { createAudiencePulseApplicationModule } from "../../../src/app/composition/builtIn/audiencePulseModule.js";
import type { AppDependencies } from "../../../src/app/server/types.js";
import type { UsageEventRecorder } from "../../../src/shared/domain/usageEventRecorder.js";

const buildMount = () => {
  const registry = createApplicationExtensionRegistry();
  new ApplicationModuleCoordinator({
    logger: { error() {} },
    registry,
  }).apply([createAudiencePulseApplicationModule()]);

  const mount = registry.routeMounts[0];
  if (!mount) throw new Error("Audience Pulse route mount was not registered");
  return mount;
};

const fakeDependencies = (recorder: UsageEventRecorder) => ({
  connectorDb: { kysely: {} },
  llmCapabilityResolver: {},
  usageEventRecorder: recorder,
  usageLimitPolicy: {},
  auditService: {},
  logger: {},
  accountAccessService: {},
  abuseControlService: {},
  telemetryService: { emit: vi.fn().mockResolvedValue(undefined) },
  env: {},
}) as unknown as AppDependencies;

describe("Audience Pulse application module", () => {
  beforeEach(() => {
    constructedWithRecorder.mockClear();
    constructedRewriteWithRecorder.mockClear();
  });

  it("passes the app usage recorder into its structured inference factory", () => {
    const recorder: UsageEventRecorder = {
      async recordEmbedding() {},
      async recordModelCall() {},
    };

    buildMount().createRouter(fakeDependencies(recorder));

    expect(constructedWithRecorder).toHaveBeenCalledWith(recorder);
  });

  it("composes the topic census service factory with real repositories and both model tiers without throwing", () => {
    const recorder: UsageEventRecorder = {
      async recordEmbedding() {},
      async recordModelCall() {},
    };

    expect(() => buildMount().createRouter(fakeDependencies(recorder))).not.toThrow();

    // Naming uses the answer tier -- the same `ContextualStructuredInferenceFactory`
    // default `AudiencePulseService`'s own analysis call uses -- so this constructor
    // fires twice: once for that call, once for naming.
    expect(constructedWithRecorder).toHaveBeenCalledTimes(2);
    expect(constructedWithRecorder).toHaveBeenCalledWith(recorder);
    // The privacy audit is the only cheap-tier call this module wires.
    expect(constructedRewriteWithRecorder).toHaveBeenCalledTimes(1);
    expect(constructedRewriteWithRecorder).toHaveBeenCalledWith(recorder);
  });
});
