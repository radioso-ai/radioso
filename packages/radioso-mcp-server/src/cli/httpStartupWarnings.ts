import type { RadiosoMcpConfig } from "../config.js";

const wildcardBindHosts = new Set(["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);

export const getHttpStartupWarnings = (config: Pick<RadiosoMcpConfig, "bindHost">): string[] => {
  if (!wildcardBindHosts.has(config.bindHost)) {
    return [];
  }

  return [
    "Radioso MCP HTTP server is bound to all network interfaces. Expose it only behind trusted network controls and TLS termination.",
  ];
};

export const emitHttpStartupWarnings = (
  config: Pick<RadiosoMcpConfig, "bindHost">,
  warn: (message: string) => void = console.warn,
) => {
  for (const warning of getHttpStartupWarnings(config)) {
    warn(warning);
  }
};
