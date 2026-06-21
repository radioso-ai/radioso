import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { InMemoryIntegrationConnectionRepository } from "../../support/inMemoryIntegrationConnections.js";

// Guards the provider-scope contract that customer-email (and future per-provider
// owners) rely on to avoid reading/mutating/deleting another provider's row on the
// shared spine by id. The in-memory double must match the SQL repository's behavior
// so unit tests built on the double stay faithful.
describe("integration connection repository provider scope", () => {
  const workspaceId = randomUUID();
  const oauthConnectionId = randomUUID();

  const seed = async () => {
    const repo = new InMemoryIntegrationConnectionRepository();
    const email = await repo.create({
      workspaceId,
      oauthConnectionId,
      provider: "customer_email_google",
      displayName: "Email",
      config: { senderEmail: "support@example.com" },
    });
    const slack = await repo.create({
      workspaceId,
      oauthConnectionId,
      provider: "slack",
      displayName: "Slack",
      config: {},
    });
    return { repo, email, slack };
  };

  const emailScope = ["customer_email_google", "customer_email_microsoft"];

  it("findById returns the in-scope provider row and hides out-of-scope rows", async () => {
    const { repo, email, slack } = await seed();
    expect(await repo.findById(workspaceId, email.id, emailScope)).toMatchObject({ id: email.id });
    expect(await repo.findById(workspaceId, slack.id, emailScope)).toBeNull();
    // No scope = unconstrained (other callers/owners).
    expect(await repo.findById(workspaceId, slack.id)).toMatchObject({ id: slack.id });
  });

  it("update refuses an out-of-scope provider row and leaves it untouched", async () => {
    const { repo, slack } = await seed();
    expect(await repo.update(workspaceId, slack.id, { displayName: "hijacked" }, emailScope)).toBeNull();
    expect(await repo.findById(workspaceId, slack.id)).toMatchObject({ displayName: "Slack" });
  });

  it("remove refuses an out-of-scope provider row and leaves it intact", async () => {
    const { repo, slack } = await seed();
    expect(await repo.remove(workspaceId, slack.id, emailScope)).toBe(false);
    expect(await repo.findById(workspaceId, slack.id)).not.toBeNull();
  });
});
