import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { DefaultOriginMatcher } from "../../src/modules/accessGrants/originMatcher.js";
import { AccessGrantService } from "../../src/modules/accessGrants/services/accessGrantService.js";
import { InMemoryAccessGrantRepository } from "../support/fakes.js";

const createService = () => {
  const repository = new InMemoryAccessGrantRepository();
  const service = new AccessGrantService({
    repository,
    originMatcher: new DefaultOriginMatcher(),
    workspaceTokenSecret: "0123456789abcdef0123456789abcdef",
  });
  return { repository, service };
};

describe("AccessGrantService", () => {
  it("defaults public-launch MCP converse grants to the agent role", async () => {
    const { service } = createService();

    const { grant } = await service.issueGrant({
      agentId: randomUUID(),
      workspaceId: randomUUID(),
      principalKind: "public-launch",
      channel: "mcp-converse",
      originConstraint: { mode: "allow-all", origins: [] },
    });

    expect(grant).toMatchObject({
      principalKind: "public-launch",
      channel: "mcp-converse",
      role: "agent",
    });
  });

  it("resolves only public-launch grants issued on the MCP converse channel", async () => {
    const { service } = createService();
    const common = {
      agentId: randomUUID(),
      workspaceId: randomUUID(),
      principalKind: "public-launch" as const,
      originConstraint: { mode: "allow-all" as const, origins: [] as [] },
    };

    const converse = await service.issueGrant({ ...common, channel: "mcp-converse" });
    const embed = await service.issueGrant({ ...common, channel: "embed" });
    const publicLink = await service.issueGrant({ ...common, channel: "public-link" });

    await expect(service.resolveConverseGrant(converse.token)).resolves.toMatchObject({
      id: converse.grant.id,
      channel: "mcp-converse",
      role: "agent",
    });
    await expect(service.resolveConverseGrant(embed.token)).resolves.toBeNull();
    await expect(service.resolveConverseGrant(publicLink.token)).resolves.toBeNull();
  });

  it("does not resolve workspace API-token grants as converse grants", async () => {
    const { service } = createService();
    const workspaceTokenGrant = await service.issueGrant({
      agentId: randomUUID(),
      workspaceId: randomUUID(),
      principalKind: "workspace-admin",
      role: "agent",
      channel: "mcp-converse",
      originConstraint: { mode: "allow-all", origins: [] },
    });

    await expect(service.resolveConverseGrant(workspaceTokenGrant.token)).resolves.toBeNull();
  });
});
