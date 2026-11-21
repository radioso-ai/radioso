import { describe, expect, it } from "vitest";

import { ApiConnectionService } from "../../../src/modules/apiRequestSkills/public.js";
import { assertPublicHttpTarget } from "../../../src/shared/infra/http/publicUrlFetch.js";
import { InMemoryApiConnectionRepository } from "../../support/inMemoryApiConnections.js";

type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

const serviceWith = (assertPublicUrl: (url: string) => Promise<void>) =>
  new ApiConnectionService({
    repository: new InMemoryApiConnectionRepository({ listByWorkspace: async () => [] }),
    auditService: { record: async () => undefined },
    encryption: { key: undefined },
    assertPublicUrl,
    send: async () => ({ kind: "failed", reason: "unreachable", durationMs: 0 }),
  });

/** The guard the app composes for API connections is the shared public-network one; its refusal must name the base URL. */
const guardedBy = (lookup: Lookup) => serviceWith((url) => assertPublicHttpTarget(url, lookup));

const create = (service: ApiConnectionService, baseUrl: string) =>
  service.create({
    workspaceId: "ws-1",
    actor: {},
    body: { name: "Orders", baseUrl, authScheme: "none", defaultHeaders: {} } as never,
  });

describe("API connection base URL egress refusal", () => {
  it.each([
    ["a literal private address", "https://10.0.0.5/v1", async () => [{ address: "10.0.0.5", family: 4 }]],
    ["a name resolving to a private address", "https://127.0.0.1.nip.io", async () => [{ address: "127.0.0.1", family: 4 }]],
  ])("names the base URL for %s", async (_label, baseUrl, lookup) => {
    await expect(create(guardedBy(lookup), baseUrl)).rejects.toMatchObject({
      statusCode: 400,
      message: "Base URL must resolve to a publicly routable host",
    });
  });

  it("says the base URL's host could not be resolved when DNS fails", async () => {
    const service = guardedBy(async () => {
      throw new Error("ENOTFOUND");
    });
    await expect(create(service, "https://nowhere.example")).rejects.toMatchObject({
      statusCode: 400,
      message: "Base URL host could not be resolved",
    });
  });

  it("lets an error that is no refusal of the guard through as it is", async () => {
    const fault = new TypeError("resolver is not a function");
    const service = serviceWith(async () => {
      throw fault;
    });
    await expect(create(service, "https://orders.example")).rejects.toBe(fault);
  });
});
