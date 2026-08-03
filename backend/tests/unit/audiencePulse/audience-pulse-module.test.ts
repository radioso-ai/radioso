import { describe, expect, it, vi } from "vitest";

const { constructedWithRecorder } = vi.hoisted(() => ({
  constructedWithRecorder: vi.fn(),
}));

vi.mock("../../../src/shared/infra/llm/contextualGateways.js", () => ({
  ContextualStructuredInferenceFactory: class {
    constructor(_deps: unknown, recorder: unknown) {
      constructedWithRecorder(recorder);
    }
  },
}));

import {
  ApplicationModuleCoordinator,
  createApplicationExtensionRegistry,
} from "../../../src/app/composition/applicationModule.js";
import { createAudiencePulseApplicationModule } from "../../../src/app/composition/builtIn/audiencePulseModule.js";
import type { AppDependencies } from "../../../src/app/server/types.js";
import type { UsageEventRecorder } from "../../../src/shared/domain/usageEventRecorder.js";

describe("Audience Pulse application module", () => {
  it("passes the app usage recorder into its structured inference factory", () => {
    const recorder: UsageEventRecorder = {
      async recordEmbedding() {},
      async recordModelCall() {},
    };
    const registry = createApplicationExtensionRegistry();
    new ApplicationModuleCoordinator({
      logger: { error() {} },
      registry,
    }).apply([createAudiencePulseApplicationModule()]);

    const mount = registry.routeMounts[0];
    if (!mount) throw new Error("Audience Pulse route mount was not registered");
    mount.createRouter({
      connectorDb: { kysely: {} },
      llmCapabilityResolver: {},
      usageEventRecorder: recorder,
      usageLimitPolicy: {},
      auditService: {},
      logger: {},
      accountAccessService: {},
      abuseControlService: {},
      env: {},
    } as unknown as AppDependencies);

    expect(constructedWithRecorder).toHaveBeenCalledWith(recorder);
  });
});
