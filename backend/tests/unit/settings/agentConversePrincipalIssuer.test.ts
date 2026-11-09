import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAgentConverseOriginVerifier,
  createAgentConverseWalkInIssuer,
} from "../../../src/app/composition/agentConverseOrigins.js";
import type { AccessGrant } from "../../../src/modules/accessGrants/domain.js";
import { AgentConversePrincipalIssuer } from "../../../src/modules/settings/composition.js";
import { converseGrantVersion } from "../../../src/modules/settings/domain/converseGrantVersion.js";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const PUBLIC_ID = "ag_0123456789abcdefghijkl";
const WALK_IN_LIFETIME_MS = 12 * 60 * 60 * 1000;

const grant: AccessGrant = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: WORKSPACE_ID,
  agentId: AGENT_ID,
  label: "Converse",
  principalKind: "agent-api",
  role: "agent",
  channel: "mcp-converse",
  tokenPrefix: "radioso_mcp",
  tokenHash: "hash",
  encryptedToken: null,
  originConstraint: { mode: "allow-all", origins: [] },
  enabled: true,
  expiresAt: new Date(Date.now() + 60 * 60_000),
  createdAt: new Date(),
  lastUsedAt: null,
  revokedAt: null,
};

const walkInAgent = (overrides: Record<string, unknown> = {}) => ({
  id: AGENT_ID,
  workspaceId: WORKSPACE_ID,
  name: "Returns desk",
  publicId: PUBLIC_ID,
  publicAgentAccessEnabled: true,
  ...overrides,
});

const createIssuer = (input: {
  agent?: Record<string, unknown> | null;
  converseGrant?: AccessGrant | null;
  publicLaunchGrant?: AccessGrant | null;
  storedGrant?: AccessGrant | null;
  evaluation?: { allowed: true } | { allowed: false; reason: string };
} = {}) => {
  const agent = input.agent === undefined ? walkInAgent() : input.agent;
  const agentRepository = { findByPublicId: vi.fn().mockResolvedValue(agent) };
  const evaluate = vi.fn().mockReturnValue(input.evaluation ?? { allowed: true });
  const walkInObserver = { record: vi.fn() };
  const accessGrantService = {
    resolvePublicLaunchGrant: vi.fn().mockResolvedValue(input.publicLaunchGrant ?? null),
    resolveConverseGrant: vi.fn().mockResolvedValue(input.converseGrant === undefined ? grant : input.converseGrant),
    evaluate,
    recordAuthFailure: vi.fn().mockResolvedValue(undefined),
  };
  const issuer = new AgentConversePrincipalIssuer({
    channel: "a2a",
    accessGrantService,
    agentLookup: { findByIdAndWorkspaceId: vi.fn().mockResolvedValue({ id: AGENT_ID, name: "Returns desk" }) },
    // The verifier MCP sessions use, unchanged: the issuer adds no re-check of its own.
    originVerifier: createAgentConverseOriginVerifier({
      accessGrantService: {
        findGrantById: vi.fn().mockResolvedValue(input.storedGrant === undefined ? grant : input.storedGrant),
        evaluate,
        recordAuthFailure: vi.fn().mockResolvedValue(undefined),
      },
      agentRepository,
    }),
    walkInIssuer: createAgentConverseWalkInIssuer({ agentRepository }),
    walkInObserver,
  });
  return { issuer, agentRepository, accessGrantService, walkInObserver };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentConversePrincipalIssuer.open", () => {
  it("opens a walk-in conversation for the bound channel, with the walk-in session lifetime", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-09T10:00:00.000Z") });
    const { issuer, walkInObserver } = createIssuer();

    const opened = await issuer.open({ publicId: PUBLIC_ID, sourceDigest: "digest-1" });

    expect(opened).toEqual({
      ok: true,
      opening: {
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        publicSessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        origin: { kind: "walk_in", publicId: PUBLIC_ID },
        expiresAt: new Date(Date.parse("2026-11-09T10:00:00.000Z") + WALK_IN_LIFETIME_MS).toISOString(),
      },
      principal: expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        origin: { kind: "walk_in", publicId: PUBLIC_ID },
        sourceChannel: "a2a",
        sourceOrigin: null,
        authPrincipal: expect.objectContaining({ type: "public_chat_session", role: "agent" }),
      }),
    });
    if (!opened.ok) throw new Error("expected an opening");
    expect(opened.principal.publicSessionId).toBe(opened.opening.publicSessionId);
    expect(walkInObserver.record).toHaveBeenCalledWith({ outcome: "issued", agentId: AGENT_ID, sourceDigest: "digest-1" });
  });

  it("refuses a closed or unknown walk-in door with one typed refusal and no copy", async () => {
    const closed = createIssuer({ agent: walkInAgent({ publicAgentAccessEnabled: false }) });
    const unknown = createIssuer({ agent: null });

    const refusedClosed = await closed.issuer.open({ publicId: PUBLIC_ID, sourceDigest: "digest-1" });
    const refusedUnknown = await unknown.issuer.open({ publicId: PUBLIC_ID, sourceDigest: "digest-1" });

    expect(refusedClosed).toEqual({ ok: false, refusal: { statusCode: 403, code: "walk_in_unavailable" } });
    expect(refusedUnknown).toEqual(refusedClosed);
    expect(closed.walkInObserver.record).toHaveBeenCalledWith({ outcome: "disabled", sourceDigest: "digest-1" });
    expect(unknown.walkInObserver.record).toHaveBeenCalledWith({ outcome: "unknown", sourceDigest: "digest-1" });
  });

  it("opens a fresh conversation for every grant opening, rather than the one pinned per grant version", async () => {
    const { issuer } = createIssuer();

    const first = await issuer.open({ launchToken: "radioso_mcp_secret" });
    const second = await issuer.open({ launchToken: "radioso_mcp_secret" });

    if (!first.ok || !second.ok) throw new Error("expected two openings");
    expect(first.opening.origin).toEqual({ kind: "grant", grantId: grant.id, grantVersion: converseGrantVersion(grant) });
    expect(first.opening.expiresAt).toBeNull();
    expect(first.principal.sourceChannel).toBe("a2a");
    expect(first.opening.publicSessionId).not.toBe(second.opening.publicSessionId);
  });

  it("refuses a grant with the exchange's own refusal codes", async () => {
    const unknownToken = await createIssuer({ converseGrant: null }).issuer.open({ launchToken: "nope" });
    const inactive = await createIssuer({ evaluation: { allowed: false, reason: "revoked" } }).issuer.open({ launchToken: "radioso_mcp_secret" });
    const publicLink = await createIssuer({ publicLaunchGrant: { ...grant, channel: "public-link" } })
      .issuer.open({ launchToken: "radioso_public_secret" });

    expect(unknownToken).toEqual({ ok: false, refusal: { statusCode: 401, code: "invalid_converse_grant" } });
    expect(inactive).toEqual({ ok: false, refusal: { statusCode: 403, code: "grant_revoked" } });
    expect(publicLink).toEqual({ ok: false, refusal: { statusCode: 403, code: "grant_channel_not_allowed" } });
  });

  it("lets a fault that is not a refusal propagate", async () => {
    const { issuer, accessGrantService } = createIssuer();
    accessGrantService.resolveConverseGrant.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(issuer.open({ launchToken: "radioso_mcp_secret" })).rejects.toThrow("database unavailable");
  });
});

describe("AgentConversePrincipalIssuer.verify", () => {
  it("re-admits an opening and issues the same principal it opened with", async () => {
    const { issuer } = createIssuer();
    const opened = await issuer.open({ publicId: PUBLIC_ID });
    if (!opened.ok) throw new Error("expected an opening");

    await expect(issuer.verify(opened.opening)).resolves.toEqual({ ok: true, principal: opened.principal });
  });

  it("ends a walk-in opening once the public id rotates or the door closes, through the shared verifier", async () => {
    const { issuer, agentRepository } = createIssuer();
    const opened = await issuer.open({ publicId: PUBLIC_ID });
    if (!opened.ok) throw new Error("expected an opening");

    agentRepository.findByPublicId.mockResolvedValue(walkInAgent({ publicAgentAccessEnabled: false }));

    await expect(issuer.verify(opened.opening)).resolves.toEqual({
      ok: false,
      refusal: { statusCode: 403, code: "walk_in_revoked" },
    });
  });

  it("ends a grant opening once the grant is rotated", async () => {
    const { issuer } = createIssuer({ storedGrant: { ...grant, tokenHash: "rotated-hash" } });
    const opened = await issuer.open({ launchToken: "radioso_mcp_secret" });
    if (!opened.ok) throw new Error("expected an opening");

    await expect(issuer.verify(opened.opening, { launchToken: "radioso_mcp_secret" })).resolves.toEqual({
      ok: false,
      refusal: { statusCode: 403, code: "grant_rotated" },
    });
  });

  it("ends a walk-in opening at its absolute lifetime without consulting the verifier", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-09T10:00:00.000Z") });
    const { issuer, agentRepository } = createIssuer();
    const opened = await issuer.open({ publicId: PUBLIC_ID });
    if (!opened.ok) throw new Error("expected an opening");
    agentRepository.findByPublicId.mockClear();

    vi.setSystemTime(Date.parse("2026-11-09T10:00:00.000Z") + WALK_IN_LIFETIME_MS);

    await expect(issuer.verify(opened.opening)).resolves.toEqual({
      ok: false,
      refusal: { statusCode: 401, code: "opening_expired" },
    });
    expect(agentRepository.findByPublicId).not.toHaveBeenCalled();
  });

  it("re-admits a grant opening only when the caller presents that same grant, without opening anything", async () => {
    const { issuer, accessGrantService } = createIssuer();
    const opened = await issuer.open({ launchToken: "radioso_mcp_secret" });
    if (!opened.ok) throw new Error("expected an opening");
    accessGrantService.resolveConverseGrant.mockClear();
    accessGrantService.resolvePublicLaunchGrant.mockClear();

    await expect(issuer.verify(opened.opening, { launchToken: "radioso_mcp_secret" })).resolves.toEqual({
      ok: true,
      principal: opened.principal,
    });
    expect(accessGrantService.resolveConverseGrant).toHaveBeenCalledTimes(1);
    expect(accessGrantService.resolvePublicLaunchGrant).not.toHaveBeenCalled();
  });

  it("refuses a grant opening presented with no credential, an unknown one, or another grant", async () => {
    const { issuer, accessGrantService } = createIssuer();
    const opened = await issuer.open({ launchToken: "radioso_mcp_secret" });
    if (!opened.ok) throw new Error("expected an opening");

    const bare = await issuer.verify(opened.opening);
    accessGrantService.resolveConverseGrant.mockResolvedValueOnce(null);
    const unknownToken = await issuer.verify(opened.opening, { launchToken: "nope" });
    accessGrantService.resolveConverseGrant.mockResolvedValueOnce({ ...grant, id: "44444444-4444-4444-8444-444444444444" });
    const otherGrant = await issuer.verify(opened.opening, { launchToken: "radioso_mcp_other" });

    expect(bare).toEqual({ ok: false, refusal: { statusCode: 401, code: "converse_grant_required" } });
    expect(unknownToken).toEqual({ ok: false, refusal: { statusCode: 401, code: "invalid_converse_grant" } });
    expect(otherGrant).toEqual({ ok: false, refusal: { statusCode: 403, code: "origin_mismatch" } });
  });

  it("refuses a walk-in opening presented with a credential: it continues only under the origin that opened it", async () => {
    const { issuer, accessGrantService } = createIssuer();
    const opened = await issuer.open({ publicId: PUBLIC_ID });
    if (!opened.ok) throw new Error("expected an opening");

    await expect(issuer.verify(opened.opening, { launchToken: "radioso_mcp_secret" })).resolves.toEqual({
      ok: false,
      refusal: { statusCode: 403, code: "origin_mismatch" },
    });
    expect(accessGrantService.resolveConverseGrant).not.toHaveBeenCalled();
  });
});
