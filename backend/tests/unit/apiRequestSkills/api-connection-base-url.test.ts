import { describe, expect, it } from "vitest";

import { ApiConnectionService } from "../../../src/modules/apiRequestSkills/public.js";
import { assertPublicWebsiteUrl } from "../../../src/modules/websiteCrawler/urlPolicy.js";
import { InMemoryApiConnectionRepository } from "../../support/inMemoryApiConnections.js";

/** The guard the app composes for API connections is the website crawler's; the refusal must still name the base URL. */
const serviceWith = (lookup: (host: string) => Promise<{ address: string; family: number }[]>) =>
  new ApiConnectionService({
    repository: new InMemoryApiConnectionRepository({ listByWorkspace: async () => [] }),
    auditService: { record: async () => undefined },
    encryption: { key: undefined },
    assertPublicUrl: (url) => assertPublicWebsiteUrl(url, { lookup }),
    send: async () => ({ kind: "failed", reason: "unreachable", durationMs: 0 }),
  });

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
    await expect(create(serviceWith(lookup), baseUrl)).rejects.toMatchObject({
      message: "Base URL must resolve to a publicly routable host",
    });
  });

  it("refuses a host that does not resolve with the same base URL wording", async () => {
    const service = serviceWith(async () => {
      throw new Error("ENOTFOUND");
    });
    await expect(create(service, "https://nowhere.example")).rejects.toMatchObject({
      message: "Base URL must resolve to a publicly routable host",
    });
  });
});
