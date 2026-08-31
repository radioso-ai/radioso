import { describe, expect, it, vi } from "vitest";

import {
  createMergedMcpPurgeReadinessObserver,
  getMcpMountStatus,
} from "../../src/app/server/mcpMount.js";

describe("merged MCP readiness status", () => {
  it("logs only bounded non-secret legacy-session purge readiness signals", () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const observer = createMergedMcpPurgeReadinessObserver(logger as never);

    observer.emit({ attempt: 1, type: "attempt" });
    observer.emit({ attempt: 1, type: "failure" });
    observer.emit({ attempt: 1, retryDelayMs: 1_000, type: "retry" });
    observer.emit({ attempt: 2, type: "success" });

    expect(logger.info).toHaveBeenCalledWith(
      { mcpLegacySessionPurge: { attempt: 1, type: "attempt" } },
      "MCP legacy-session purge attempt started",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { mcpLegacySessionPurge: { attempt: 1, type: "failure" } },
      "MCP legacy-session purge attempt failed",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { mcpLegacySessionPurge: { attempt: 1, retryDelayMs: 1_000, type: "retry" } },
      "MCP legacy-session purge retry scheduled",
    );
    expect(logger.info).toHaveBeenCalledWith(
      { mcpLegacySessionPurge: { attempt: 2, type: "success" } },
      "MCP legacy-session purge completed",
    );
    expect(JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls])).not.toContain("token");
  });

  it("does not report an enabled merged runtime ready before purge readiness exists", () => {
    expect(getMcpMountStatus({
      RADIOSO_MCP_ENABLED: true,
      RADIOSO_MCP_MOUNT_PATH: "/mcp",
      RADIOSO_MCP_STANDALONE: false,
    })).toMatchObject({ enabled: true, mode: "merged", ready: false });
  });

  it("keeps disabled and standalone backend mounts ready", () => {
    expect(getMcpMountStatus({
      RADIOSO_MCP_ENABLED: false,
      RADIOSO_MCP_MOUNT_PATH: "/mcp",
      RADIOSO_MCP_STANDALONE: true,
    })).toMatchObject({ enabled: false, mode: "standalone", ready: true });
  });
});
