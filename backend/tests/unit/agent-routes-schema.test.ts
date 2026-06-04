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
});
