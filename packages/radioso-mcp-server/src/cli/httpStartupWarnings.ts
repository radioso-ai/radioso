import type { RadiosoMcpConfig } from "../config.js";
import type { LegacySessionPurgeReadinessEvent, LegacySessionPurgeReadinessObserver } from "../state/runtimeStores.js";

const wildcardBindHosts = new Set(["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);

export const getHttpStartupWarnings = (
  config: Pick<RadiosoMcpConfig, "bindHost" | "signingSecret">,
): string[] => {
  const warnings: string[] = [];

  if (wildcardBindHosts.has(config.bindHost)) {
    warnings.push(
      "Radioso MCP HTTP server is bound to all network interfaces. Expose it only behind trusted network controls and TLS termination.",
    );
  }
  if (!config.signingSecret) {
    warnings.push("RADIOSO_MCP_SIGNING_SECRET is not set; source budgets reset when this MCP process restarts.");
  }

  return warnings;
};

export const emitHttpStartupWarnings = (
  config: Pick<RadiosoMcpConfig, "bindHost" | "signingSecret">,
  warn: (message: string) => void = console.warn,
) => {
  for (const warning of getHttpStartupWarnings(config)) {
    warn(warning);
  }
};

export const createHttpStartupReadinessObserver = (
  info: (message: string) => void = console.info,
): LegacySessionPurgeReadinessObserver => ({
  emit(event: LegacySessionPurgeReadinessEvent) {
    switch (event.type) {
      case "attempt":
        info(`MCP runtime readiness purge attempt ${event.attempt}`);
        break;
      case "failure":
        info(`MCP runtime readiness purge failure (attempt ${event.attempt})`);
        break;
      case "retry":
        info(`MCP runtime readiness purge retry scheduled (attempt ${event.attempt}, delay ${event.retryDelayMs}ms)`);
        break;
      case "success":
        info(`MCP runtime readiness purge success (attempt ${event.attempt})`);
        break;
    }
  },
});
