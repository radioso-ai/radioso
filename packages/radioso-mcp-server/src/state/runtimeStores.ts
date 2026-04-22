import type { RadiosoMcpConfig } from "../config.js";
import { createInMemoryApprovalStore } from "../auth/approvalStore.js";
import { createInMemorySessionStore } from "../auth/sessionStore.js";

import { createRedisClientHandle } from "./redisRuntimeStore.js";

export interface RuntimeStoreHandle {
  close(): Promise<void>;
  mode: "in-memory" | "redis";
  approvalStore: ReturnType<typeof createInMemoryApprovalStore>;
  sessionStore: ReturnType<typeof createInMemorySessionStore>;
}

export const createRuntimeStoreHandle = async (config: RadiosoMcpConfig): Promise<RuntimeStoreHandle> => {
  if (config.redisUrl) {
    const redisHandle = await createRedisClientHandle({
      keyPrefix: config.redisKeyPrefix,
      redisUrl: config.redisUrl,
    });

    return {
      approvalStore: redisHandle.approvalStore,
      async close() {
        await redisHandle.close();
      },
      mode: "redis",
      sessionStore: redisHandle.sessionStore,
    };
  }

  return {
    approvalStore: createInMemoryApprovalStore(),
    async close() {},
    mode: "in-memory",
    sessionStore: createInMemorySessionStore(),
  };
};
