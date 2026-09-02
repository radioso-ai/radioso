import { describe, expect, it } from "vitest";

import { AccessGrantService } from "../../src/modules/accessGrants/services/accessGrantService.js";
import { DefaultOriginMatcher } from "../../src/modules/accessGrants/originMatcher.js";
import type { AccessGrant, OriginConstraint } from "../../src/modules/accessGrants/domain.js";

const grantWith = (originConstraint: OriginConstraint): AccessGrant => ({
  id: "grant-1",
  agentId: "agent-1",
  workspaceId: "workspace-1",
  label: "website-embed",
  principalKind: "public-launch",
  role: "public",
  channel: "public-link",
  tokenPrefix: "",
  tokenHash: "hash",
  encryptedToken: "encrypted",
  originConstraint,
  enabled: true,
  expiresAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  lastUsedAt: null,
  revokedAt: null,
});

const service = new AccessGrantService({
  repository: {} as never,
  lifecycleUnitOfWork: {} as never,
  originMatcher: new DefaultOriginMatcher(),
  workspaceTokenSecret: "fedcba9876543210fedcba9876543210",
});

describe("AccessGrantService.evaluate origin policy", () => {
  const listed = grantWith({ mode: "list", origins: ["https://a.example"] });

  it("allows a present, listed origin and denies an unlisted one", () => {
    expect(service.evaluate(listed, { origin: "https://a.example" })).toEqual({ allowed: true });
    expect(service.evaluate(listed, { origin: "https://b.example" })).toEqual({
      allowed: false,
      reason: "origin_denied",
    });
  });

  it("treats an absent origin as allowed — there is no Origin to enforce (#609→#612 same-origin widget)", () => {
    // null = request had no Origin header; undefined = caller did not supply one.
    expect(service.evaluate(listed, { origin: null })).toEqual({ allowed: true });
    expect(service.evaluate(listed, { origin: undefined })).toEqual({ allowed: true });
    expect(service.evaluate(listed, {})).toEqual({ allowed: true });
  });

  it("allows any origin (and no origin) for an allow-all constraint", () => {
    const all = grantWith({ mode: "allow-all", origins: [] });
    expect(service.evaluate(all, { origin: "https://anything.example" })).toEqual({ allowed: true });
    expect(service.evaluate(all, { origin: null })).toEqual({ allowed: true });
  });
});
