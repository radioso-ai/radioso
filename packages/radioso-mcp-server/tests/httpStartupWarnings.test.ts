import { describe, expect, it, vi } from "vitest";

import { emitHttpStartupWarnings, getHttpStartupWarnings } from "../src/cli/httpStartupWarnings.js";

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
});
