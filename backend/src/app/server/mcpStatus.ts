import type { AppDependencies } from "./types.js";

type McpStatusDependencies = Pick<
  AppDependencies["env"],
  "RADIOSO_MCP_ENABLED" | "RADIOSO_MCP_MOUNT_PATH" | "RADIOSO_MCP_STANDALONE"
>;

export const getMcpStatus = (env: McpStatusDependencies) => {
  const standalone = env.RADIOSO_MCP_ENABLED && env.RADIOSO_MCP_STANDALONE;

  return {
    enabled: standalone,
    mode: standalone ? "standalone" : "disabled",
    path: env.RADIOSO_MCP_MOUNT_PATH,
    ready: true,
    standalone,
  };
};
