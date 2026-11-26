import { afterEach, describe, expect, it, vi } from "vitest";

import { buildOperatorMcpServices } from "../../../src/app/server/builders/operatorMcp.js";
import type { Env } from "../../../src/app/config/env.js";

const loopbackClientId = "http://127.0.0.1:55103/client.json";
const redirectUri = "http://127.0.0.1:55103/callback";

const resolveLoopbackClient = async (nodeEnv: Env["NODE_ENV"]) => {
  const fetchSpy = vi.fn<typeof fetch>().mockRejectedValue(new Error("fetch attempted"));
  vi.stubGlobal("fetch", fetchSpy);
  const services = buildOperatorMcpServices({
    env: { NODE_ENV: nodeEnv } as Env,
    database: { kysely: {} } as never,
    accountAccessService: {} as never,
    auditService: {} as never,
    logger: {} as never,
    metricsRegistry: null,
    copilotToolCatalog: [],
  });
  const outcome = await services.operatorMcpClientResolver.resolve(loopbackClientId, redirectUri).then(
    () => "resolved",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  return { outcome, fetched: fetchSpy.mock.calls.length > 0 };
};

describe("operator MCP loopback client ids by environment", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["production", "test"] as const)("rejects a loopback client id without fetching it under NODE_ENV=%s", async (nodeEnv) => {
    const result = await resolveLoopbackClient(nodeEnv);
    expect(result.fetched).toBe(false);
    expect(result.outcome).toMatch(/Invalid client metadata URL/u);
  });

  it("fetches a loopback client id under NODE_ENV=development", async () => {
    const result = await resolveLoopbackClient("development");
    expect(result.fetched).toBe(true);
    expect(result.outcome).not.toMatch(/Invalid client metadata URL/u);
  });
});
