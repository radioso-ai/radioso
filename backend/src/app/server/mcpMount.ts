import type { Express } from "express";
import {
  createLegacySessionPurgeRuntime,
  type LegacySessionPurgeReadinessObserver,
  type LegacySessionPurgeRuntime,
} from "@radioso/mcp-server";

import type { AppDependencies } from "./types.js";

type McpMountDependencies = Pick<AppDependencies, "env" | "logger">;

type MergedMcpPurgeState = {
  creationPromise?: Promise<void>;
  failed: boolean;
  runtime?: LegacySessionPurgeRuntime;
  stopped: boolean;
};

const mergedMcpPurgeStates = new WeakMap<object, MergedMcpPurgeState>();

export const createMergedMcpPurgeReadinessObserver = (
  logger: Pick<AppDependencies["logger"], "info" | "warn">,
): LegacySessionPurgeReadinessObserver => ({
  emit(event) {
    const message = {
      attempt: "MCP legacy-session purge attempt started",
      failure: "MCP legacy-session purge attempt failed",
      retry: "MCP legacy-session purge retry scheduled",
      success: "MCP legacy-session purge completed",
    }[event.type];
    const level = event.type === "failure" || event.type === "retry" ? "warn" : "info";
    logger[level]({ mcpLegacySessionPurge: event }, message);
  },
});

export const getMcpMountStatus = (
  env: Pick<AppDependencies["env"], "RADIOSO_MCP_ENABLED" | "RADIOSO_MCP_MOUNT_PATH" | "RADIOSO_MCP_STANDALONE">
    & Partial<Pick<AppDependencies["env"], "RADIOSO_MCP_REDIS_URL">>,
) => {
  const mergedConfigured = env.RADIOSO_MCP_ENABLED && !env.RADIOSO_MCP_STANDALONE;
  // Merged MCP has no eligible bearer class after the workspace credential was removed.
  // Keep this explicit in health so clients do not treat a configured dead route as usable.
  const enabled = false;
  const purgeState = mergedMcpPurgeStates.get(env);
  const purgeConfigured = mergedConfigured && Boolean(env.RADIOSO_MCP_REDIS_URL);
  return {
    enabled,
    failed: purgeConfigured ? purgeState?.failed ?? false : false,
    mode: env.RADIOSO_MCP_STANDALONE ? "standalone" : mergedConfigured ? "unsupported" : "disabled",
    path: env.RADIOSO_MCP_MOUNT_PATH,
    ready: purgeConfigured ? purgeState?.runtime?.readiness.isReady() ?? false : true,
    ...(mergedConfigured ? { reason: "merged_auth_unavailable" } : {}),
    standalone: env.RADIOSO_MCP_STANDALONE,
  };
};

export const mountMergedMcp = (_app: Express, dependencies: McpMountDependencies): void => {
  if (!dependencies.env.RADIOSO_MCP_ENABLED || dependencies.env.RADIOSO_MCP_STANDALONE) {
    return;
  }

  dependencies.logger.warn(
    "Merged MCP is unavailable because this release has no eligible merged authentication class; use standalone MCP with an agent-converse grant.",
  );

  if (!dependencies.env.RADIOSO_MCP_REDIS_URL || mergedMcpPurgeStates.has(dependencies.env)) {
    return;
  }

  const state: MergedMcpPurgeState = {
    failed: false,
    stopped: false,
  };
  mergedMcpPurgeStates.set(dependencies.env, state);

  state.creationPromise = createLegacySessionPurgeRuntime({
    keyPrefix: dependencies.env.RADIOSO_MCP_REDIS_KEY_PREFIX,
    observer: createMergedMcpPurgeReadinessObserver(dependencies.logger),
    redisUrl: dependencies.env.RADIOSO_MCP_REDIS_URL,
    // Purge inspection does not decrypt sessions, so cleanup remains available
    // after the merged transport's signing secret has been removed.
    signingSecret: dependencies.env.RADIOSO_MCP_SIGNING_SECRET ?? "",
  }).then(async (runtime) => {
    if (state.stopped) {
      await runtime.close();
      return;
    }
    state.runtime = runtime;
    runtime.readiness.start();
  }).catch(() => {
    state.failed = true;
    dependencies.logger.warn("Merged MCP legacy-session purge runtime could not be created.");
  });
};

export const closeMergedMcpPurgeLifecycle = async (env: object): Promise<void> => {
  const state = mergedMcpPurgeStates.get(env);
  if (!state) {
    return;
  }

  state.stopped = true;
  await state.creationPromise;
  await state.runtime?.close();
  mergedMcpPurgeStates.delete(env);
};
