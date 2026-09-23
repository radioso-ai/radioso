import { describe, expect, it, vi } from "vitest";

import {
  createAgentConverseOriginVerifier,
  createAgentConverseWalkInIssuer,
} from "../../../src/app/composition/agentConverseOrigins.js";
import { converseGrantVersion } from "../../../src/modules/settings/domain/converseGrantVersion.js";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const GRANT_ID = "11111111-1111-4111-8111-111111111111";
const PUBLIC_ID = "ag_0123456789abcdefghijkl";

const grant = {
  id: GRANT_ID,
  workspaceId: WORKSPACE_ID,
  agentId: AGENT_ID,
  principalKind: "agent-api" as const,
  channel: "mcp-converse" as const,
  tokenHash: "hash",
};

const walkInAgent = (overrides: Record<string, unknown> = {}) => ({
  id: AGENT_ID,
  workspaceId: WORKSPACE_ID,
  name: "Returns desk",
  publicId: PUBLIC_ID,
  publicAgentAccessEnabled: true,
  ...overrides,
});

const verifierWith = (agent: unknown, evaluation: { allowed: boolean; reason?: string } = { allowed: true }) =>
  createAgentConverseOriginVerifier({
    accessGrantService: {
      findGrantById: vi.fn().mockResolvedValue(grant),
      evaluate: vi.fn().mockReturnValue(evaluation),
      recordAuthFailure: vi.fn(),
    },
    agentRepository: { findByPublicId: vi.fn().mockResolvedValue(agent) },
  });

const grantOrigin = {
  origin: { kind: "grant" as const, grantId: GRANT_ID, grantVersion: converseGrantVersion(grant) },
  workspaceId: WORKSPACE_ID,
  agentId: AGENT_ID,
};

const walkInOrigin = {
  origin: { kind: "walk_in" as const, publicId: PUBLIC_ID },
  workspaceId: WORKSPACE_ID,
  agentId: AGENT_ID,
};

describe("agent converse origin verifier", () => {
  it("admits a grant session whose credential version still matches", async () => {
    await expect(verifierWith(null).revalidate(grantOrigin)).resolves.toEqual({ ok: true });
  });

  it("refuses a grant session whose credential was rotated", async () => {
    const verifier = verifierWith(null);

    await expect(verifier.revalidate({
      ...grantOrigin,
      origin: { kind: "grant", grantId: GRANT_ID, grantVersion: "stale" },
    })).resolves.toMatchObject({ ok: false, statusCode: 403, code: "grant_rotated" });
  });

  it("refuses a grant session bound to a different agent", async () => {
    await expect(verifierWith(null).revalidate({
      ...grantOrigin,
      agentId: "44444444-4444-4444-8444-444444444444",
    })).resolves.toMatchObject({ ok: false, code: "grant_rotated" });
  });

  it("admits a walk-in session while the flag is on and the id still matches", async () => {
    await expect(verifierWith(walkInAgent()).revalidate(walkInOrigin)).resolves.toEqual({ ok: true });
  });

  it("refuses a walk-in session once the flag is turned off", async () => {
    const verifier = verifierWith(walkInAgent({ publicAgentAccessEnabled: false }));

    await expect(verifier.revalidate(walkInOrigin)).resolves.toMatchObject({
      ok: false,
      statusCode: 403,
      code: "walk_in_revoked",
    });
  });

  it("refuses a walk-in session once the public id is rotated", async () => {
    const verifier = verifierWith(walkInAgent({ publicId: "ag_zzzzzzzzzzzzzzzzzzzzzz" }));

    await expect(verifier.revalidate(walkInOrigin)).resolves.toMatchObject({ ok: false, code: "walk_in_revoked" });
  });

  it("refuses a walk-in session once the agent is gone", async () => {
    await expect(verifierWith(null).revalidate(walkInOrigin)).resolves.toMatchObject({
      ok: false,
      code: "walk_in_revoked",
    });
  });
});

describe("agent converse walk-in issuer", () => {
  const issuerFor = (agent: unknown) => createAgentConverseWalkInIssuer({
    agentRepository: { findByPublicId: vi.fn().mockResolvedValue(agent) },
  });

  it("opens a walk-in target for an agent that accepts walk-in connections", async () => {
    await expect(issuerFor(walkInAgent()).open(PUBLIC_ID)).resolves.toEqual({
      ok: true,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      agentName: "Returns desk",
    });
  });

  it("tells a closed door apart from an unknown id for the outcome counter only", async () => {
    await expect(issuerFor(walkInAgent({ publicAgentAccessEnabled: false })).open(PUBLIC_ID))
      .resolves.toEqual({ ok: false, reason: "disabled" });
    await expect(issuerFor(null).open(PUBLIC_ID)).resolves.toEqual({ ok: false, reason: "unknown" });
  });
});
