import { describe, expect, it } from "vitest";

import { OperatorIdentityResolver } from "../../../src/modules/handoff/public.js";

const resolverFor = (input: {
  user: { email: string; displayName: string | null } | null;
  organizationName: string | null;
}) => new OperatorIdentityResolver({
  users: { findById: async () => input.user },
  accounts: { findById: async () => (input.organizationName === null ? null : { name: input.organizationName }) },
});

describe("OperatorIdentityResolver", () => {
  it("names the teammate and signs replies with the name they chose", async () => {
    const resolver = resolverFor({
      user: { email: "dana@example.com", displayName: "Dana Scully" },
      organizationName: "Acme",
    });

    await expect(resolver.resolve({ accountId: "account-1", userId: "user-1" })).resolves.toEqual({
      userId: "user-1",
      teammateLabel: "Dana Scully",
      replySignature: "Dana Scully",
    });
  });

  it("names the teammate by email until they choose a name, but signs replies with the organisation", async () => {
    const resolver = resolverFor({
      user: { email: "dana@example.com", displayName: null },
      organizationName: "Acme",
    });

    await expect(resolver.resolve({ accountId: "account-1", userId: "user-1" })).resolves.toEqual({
      userId: "user-1",
      teammateLabel: "dana@example.com",
      replySignature: "Acme",
    });
  });

  it("never signs a reply with an email", async () => {
    const blankOrganization = resolverFor({
      user: { email: "dana@example.com", displayName: null },
      organizationName: "   ",
    });
    const missingOrganization = resolverFor({
      user: { email: "dana@example.com", displayName: null },
      organizationName: null,
    });

    await expect(blankOrganization.resolve({ accountId: "account-1", userId: "user-1" }))
      .resolves.toMatchObject({ replySignature: null });
    await expect(missingOrganization.resolve({ accountId: "account-1", userId: "user-1" }))
      .resolves.toMatchObject({ replySignature: null });
  });

  it("rejects a user that no longer exists", async () => {
    const resolver = resolverFor({ user: null, organizationName: "Acme" });

    await expect(resolver.resolve({ accountId: "account-1", userId: "user-1" }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});
