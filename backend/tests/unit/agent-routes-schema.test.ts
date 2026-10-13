import { describe, expect, it } from "vitest";

import { agentBodySchema } from "../../src/app/http/routes/agentRoutes.js";

describe("agent route schema", () => {
  it("accepts contact request delivery settings", () => {
    expect(() =>
      agentBodySchema.parse({
        contactRequestsEnabled: true,
        contactRequestDelivery: {
          recipientEmails: ["sales@example.com"],
          webhook: { url: "https://hooks.example.com/contact" },
        },
      }),
    ).not.toThrow();
  });

  it("rejects too many contact request recipient emails", () => {
    expect(() =>
      agentBodySchema.parse({
        contactRequestDelivery: {
          recipientEmails: [
            "one@example.com",
            "two@example.com",
            "three@example.com",
            "four@example.com",
            "five@example.com",
            "six@example.com",
          ],
          webhook: null,
        },
      }),
    ).toThrow();
  });

  it("accepts a whole voice block and adds none to a body that omits it", () => {
    const voice = {
      enabled: true,
      bridgeLines: { en: { acknowledge: ["Got it."], check: ["One moment."] } },
      fallbackLine: { en: "Sorry, could you ask me again?" },
    };

    expect(agentBodySchema.parse({ voice }).voice).toEqual(voice);
    // validateBody replaces req.body with this parse, so a default here would reset the stored block.
    expect(agentBodySchema.parse({ name: "Renamed" })).not.toHaveProperty("voice");
  });

  it("rejects a voice block with a malformed locale or a missing key", () => {
    expect(() => agentBodySchema.parse({
      voice: { enabled: true, bridgeLines: {}, fallbackLine: { english: "Sorry." } },
    })).toThrow();
    expect(() => agentBodySchema.parse({ voice: { enabled: true } })).toThrow();
  });

  it("drops operator-facing public launch revoke flags", () => {
    const parsed = agentBodySchema.parse({
      revokeAnonymousChatToken: true,
      revokeWebsiteEmbedToken: true,
    });

    expect(parsed).not.toHaveProperty("revokeAnonymousChatToken");
    expect(parsed).not.toHaveProperty("revokeWebsiteEmbedToken");
  });
});
