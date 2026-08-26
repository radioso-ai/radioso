import { createNoopWorkspaceInvalidationPublisher, type WorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";
import { BoundedInvalidationProducer } from "../../modules/realtime/application/boundedInvalidationProducer.js";
import type { WorkspaceInvalidationTransport } from "../../modules/realtime/domain/contracts.js";
import type { RealtimeConfig } from "../../modules/realtime/infrastructure/config.js";
import type { RealtimeTelemetry } from "../../modules/realtime/infrastructure/realtimeTelemetry.js";
import {
  createNodeRedisClientFactory,
  RedisInvalidationPublisher,
  type RedisCredentialsProvider,
  type RedisLogicalClientFactory,
} from "../../modules/realtime/infrastructure/redisInvalidationTransport.js";

export interface RealtimePublisherComposition {
  publisher: WorkspaceInvalidationPublisher;
  shutdown(): Promise<void>;
}

/** API and workers receive only this publisher port; composition never awaits it during mutation work. */
export const createRealtimePublisherComposition = (input: {
  config: RealtimeConfig;
  transport?: WorkspaceInvalidationTransport;
  /** Composition supplies short-lived IAM credentials; the adapter requests them per new Redis connection. */
  redisCredentialsProvider?: RedisCredentialsProvider;
  redisClientFactory?: RedisLogicalClientFactory;
  telemetry?: Pick<RealtimeTelemetry, "producer"> & Partial<Pick<RealtimeTelemetry, "transport">>;
}): RealtimePublisherComposition => {
  if (input.config.mode === "disabled" || input.config.rollout.mode === "disabled") {
    return { publisher: createNoopWorkspaceInvalidationPublisher(), shutdown: async () => undefined };
  }
  const transport = input.transport ?? new RedisInvalidationPublisher({
    channelPrefix: input.config.redis.channelPrefix,
    commandTimeoutMs: input.config.redis.commandTimeoutMs,
    createClient: input.redisClientFactory ?? createNodeRedisClientFactory({
      connectTimeoutMs: input.config.redis.connectTimeoutMs,
      credentialsProvider: input.redisCredentialsProvider,
      queuedCommands: input.config.redis.queuedCommands,
      seeds: input.config.redis.seeds,
      tls: input.config.redis.tls,
      url: input.config.redis.url,
    }),
    credentialsProvider: input.redisCredentialsProvider,
    mode: input.config.mode,
    telemetry: input.telemetry?.transport,
  });
  const publisher = new BoundedInvalidationProducer({
    transport,
    options: { ...input.config.producer, shutdownTimeoutMs: input.config.gateway.shutdownDrainMs },
    telemetry: input.telemetry?.producer,
  });
  return {
    publisher,
    shutdown: async () => {
      try {
        await publisher.shutdown();
      } finally {
        await transport.close?.();
      }
    },
  };
};
