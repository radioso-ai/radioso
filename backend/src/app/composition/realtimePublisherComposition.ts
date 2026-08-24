import { createNoopWorkspaceInvalidationPublisher, type WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";
import { BoundedInvalidationProducer } from "../../modules/realtime/application/boundedInvalidationProducer.js";
import type { WorkspaceInvalidationTransport } from "../../modules/realtime/domain/contracts.js";
import type { RealtimeConfig } from "../../modules/realtime/infrastructure/config.js";
import type { RealtimeTelemetry } from "../../modules/realtime/infrastructure/realtimeTelemetry.js";

export interface RealtimePublisherComposition {
  publisher: WorkspaceInvalidationPublisher;
  shutdown(): Promise<void>;
}

/** API and workers receive only this publisher port; composition never awaits it during mutation work. */
export const createRealtimePublisherComposition = (input: {
  config: RealtimeConfig;
  transport?: WorkspaceInvalidationTransport;
  telemetry?: Pick<RealtimeTelemetry, "producer">;
}): RealtimePublisherComposition => {
  if (input.config.mode === "disabled" || input.config.rollout.mode === "disabled") {
    return { publisher: createNoopWorkspaceInvalidationPublisher(), shutdown: async () => undefined };
  }
  if (!input.transport) throw new Error("realtime publisher transport must be supplied for enabled mode");
  const publisher = new BoundedInvalidationProducer({
    transport: input.transport,
    options: { ...input.config.producer, shutdownTimeoutMs: input.config.gateway.shutdownDrainMs },
    telemetry: input.telemetry?.producer,
  });
  return {
    publisher,
    shutdown: async () => {
      try {
        await publisher.shutdown();
      } finally {
        await input.transport?.close?.();
      }
    },
  };
};
