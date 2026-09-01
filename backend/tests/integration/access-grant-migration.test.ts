import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { InMemoryAccessGrantLifecycleUnitOfWork, InMemoryAccessGrantRepository } from "../support/fakes.js";
import { AccessGrantService } from "../../src/modules/accessGrants/services/accessGrantService.js";
import { DefaultOriginMatcher } from "../../src/modules/accessGrants/originMatcher.js";

describe("access grant migration", () => {
  it("backfills existing anonymous and website embed tokens into public-launch grants", async () => {
    const repository = new InMemoryAccessGrantRepository();
    const service = new AccessGrantService({
      repository,
      lifecycleUnitOfWork: new InMemoryAccessGrantLifecycleUnitOfWork(repository),
      originMatcher: new DefaultOriginMatcher(),
      workspaceTokenSecret: "fedcba9876543210fedcba9876543210",
    });
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    await service.migratePublicLaunchToken({
      workspaceId,
      agentId,
      label: "anonymous-chat",
      token: "legacy-anonymous-token",
      originConstraint: { mode: "allow-all", origins: [] },
    });
    await service.migratePublicLaunchToken({
      workspaceId,
      agentId,
      label: "website-embed",
      token: "legacy-embed-token",
      originConstraint: { mode: "list", origins: ["https://example.com"] },
    });

    await service.migratePublicLaunchToken({
      workspaceId,
      agentId,
      label: "website-embed",
      token: "legacy-embed-token",
      originConstraint: { mode: "list", origins: ["https://example.com"] },
    });

    const anonymousGrant = await service.resolvePublicLaunchGrant("legacy-anonymous-token");
    const embedGrant = await service.resolvePublicLaunchGrant("legacy-embed-token");

    expect(anonymousGrant).toMatchObject({
      workspaceId,
      agentId,
      principalKind: "public-launch",
      role: "public",
      originConstraint: { mode: "allow-all", origins: [] },
    });
    expect(embedGrant).toMatchObject({
      workspaceId,
      agentId,
      principalKind: "public-launch",
      role: "public",
      originConstraint: { mode: "list", origins: ["https://example.com"] },
    });
    expect(anonymousGrant).not.toHaveProperty("scopes");
    expect(embedGrant).not.toHaveProperty("scopes");
    expect(repository.items.filter((grant) => grant.tokenHash === embedGrant?.tokenHash)).toHaveLength(1);
  });
});
