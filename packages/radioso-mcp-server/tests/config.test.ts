import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("reads the required env vars", () => {
    const config = loadConfig({
      RADIOSO_BASE_URL: "http://localhost:8080",
      RADIOSO_API_TOKEN: "sk_proj_test",
      RADIOSO_SERVER_NAME: "radioso-test",
    });

    expect(config).toEqual({
      apiToken: "sk_proj_test",
      baseUrl: "http://localhost:8080",
      requestTimeoutMs: 30000,
      serverName: "radioso-test",
    });
  });

  it("throws for missing required env vars", () => {
    expect(() => loadConfig({ RADIOSO_BASE_URL: "http://localhost:8080" })).toThrow(/RADIOSO_API_TOKEN/i);
  });
});
