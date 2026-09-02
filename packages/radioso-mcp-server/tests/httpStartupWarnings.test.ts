import { describe, expect, it, vi } from "vitest";

import {
  createHttpStartupReadinessObserver,
  emitHttpStartupWarnings,
  getHttpStartupWarnings,
} from "../src/cli/httpStartupWarnings.js";

describe("HTTP startup warnings", () => {
  it("warns when the HTTP server binds to every IPv4 interface", () => {
    expect(getHttpStartupWarnings({ bindHost: "0.0.0.0" })).toHaveLength(1);
  });

  it("warns when the HTTP server binds to every IPv6 interface", () => {
    expect(getHttpStartupWarnings({ bindHost: "::" })).toHaveLength(1);
    expect(getHttpStartupWarnings({ bindHost: "0:0:0:0:0:0:0:0" })).toHaveLength(1);
  });

  it("does not warn for loopback binds", () => {
    expect(getHttpStartupWarnings({ bindHost: "127.0.0.1" })).toEqual([]);
    expect(getHttpStartupWarnings({ bindHost: "localhost" })).toEqual([]);
  });

  it("emits the warning through the provided logger", () => {
    const warn = vi.fn();

    emitHttpStartupWarnings({ bindHost: "0.0.0.0" }, warn);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bound to all network interfaces"));
  });

  it("logs only bounded purge lifecycle signals without operational material", () => {
    const info = vi.fn();
    const observer = createHttpStartupReadinessObserver(info);

    observer.emit({ attempt: 1, type: "attempt" });
    observer.emit({ attempt: 1, type: "failure" });
    observer.emit({ attempt: 1, retryDelayMs: 1_000, type: "retry" });
    observer.emit({ attempt: 2, type: "success" });

    expect(info.mock.calls.map(([message]) => message)).toEqual([
      "MCP runtime readiness purge attempt 1",
      "MCP runtime readiness purge failure (attempt 1)",
      "MCP runtime readiness purge retry scheduled (attempt 1, delay 1000ms)",
      "MCP runtime readiness purge success (attempt 2)",
    ]);
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/redis|password|session|credential|store/i);
  });
});
