import { describe, expect, it, vi } from "vitest";

import { copilotProposalPermissions } from "../../../src/modules/operatorCopilot/contracts.js";
import { presentProposalCard } from "../../../src/db/repositories/copilotRepository.js";
import { OperatorCopilotService } from "../../../src/modules/operatorCopilot/service.js";

const proposalRow = (overrides: Record<string, unknown> = {}) => ({
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  workspaceId: "workspace-1",
  operatorUserId: "operator-1",
  conversationId: "conversation-1",
  messageId: "message-1",
  targetType: "document" as const,
  targetRef: { documentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
  payload: { op: "delete", name: "Refund policy", removesTarget: true },
  versionToken: "2026-08-30T10:00:00.000Z",
  evidence: null,
  status: "pending" as const,
  reason: null,
  appliedRef: null,
  createdAt: new Date("2026-08-30T10:00:00.000Z"),
  updatedAt: new Date("2026-08-30T10:00:00.000Z"),
  ...overrides,
});

const serviceFor = (proposal = proposalRow(), holds: ReadonlyArray<string> = []) => {
  const hasAllPermissions = vi.fn(async ({ requiredPermissions }: { requiredPermissions: ReadonlyArray<string> }) =>
    requiredPermissions.every((permission) => holds.includes(permission)));
  const applyIfVersionMatches = vi.fn(async () => ({ outcome: "applied" as const, appliedRef: {} }));
  const record = vi.fn(async () => undefined);
  const repository = {
    findProposal: vi.fn(async () => proposal),
    claimProposalApply: vi.fn(async () => ({ proposal, claimedAt: new Date() })),
    releaseProposalApplyClaim: vi.fn(async () => undefined),
    updateProposalOutcome: vi.fn(async () => proposal),
  };
  const service = new OperatorCopilotService({
    repository,
    proposalAdapters: [{ targetType: proposal.targetType, readVersionToken: vi.fn(), preview: vi.fn(async () => ({ targetLabel: "Refund policy", current: null, proposed: null })), applyIfVersionMatches }],
    auditService: { record },
    currentAuthorization: { hasAllPermissions },
  } as never);
  return { service, applyIfVersionMatches, hasAllPermissions, record };
};

const applyInput = { workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "operator-1", proposalId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" };

describe("proposal authorization by target type", () => {
  it("names a required permission for every proposal target type", () => {
    for (const [targetType, permissions] of Object.entries(copilotProposalPermissions)) {
      expect(permissions.length, `${targetType} names no permission`).toBeGreaterThan(0);
    }
  });

  it("lets a document manager apply a document proposal without agent management", async () => {
    const { service, applyIfVersionMatches } = serviceFor(proposalRow(), ["workspace.documents.manage"]);

    await expect(service.applyProposal(applyInput)).resolves.toMatchObject({ status: "applied" });
    expect(applyIfVersionMatches).toHaveBeenCalled();
  });

  it("refuses a document proposal to an operator who only manages agents", async () => {
    const { service, applyIfVersionMatches } = serviceFor(proposalRow(), ["workspace.agents.manage"]);

    await expect(service.applyProposal(applyInput)).rejects.toThrow();
    expect(applyIfVersionMatches).not.toHaveBeenCalled();
  });

  it("keeps agent-scoped proposals on agent management", async () => {
    const directive = proposalRow({ targetType: "directive", payload: { op: "remove", name: "Do not guess" } });
    const { service, applyIfVersionMatches } = serviceFor(directive, ["workspace.agents.manage"]);

    await expect(service.applyProposal(applyInput)).resolves.toMatchObject({ status: "applied" });
    expect(applyIfVersionMatches).toHaveBeenCalled();
  });

  it("gates ingestion settings on settings management", async () => {
    const settings = proposalRow({ targetType: "ingestion_settings", targetRef: {}, payload: { name: "Ingestion settings" } });
    const { service } = serviceFor(settings, ["workspace.documents.manage", "workspace.agents.manage"]);

    await expect(service.applyProposal(applyInput)).rejects.toThrow();
  });
});

describe("reloaded proposal cards", () => {
  it("keeps a document removal's irreversible warning and its label across a reload", () => {
    const card = presentProposalCard(proposalRow() as never);

    expect(card.targetLabel).toBe("Refund policy");
    expect(card.removal).toBe(true);
  });

  it("labels a reloaded ingestion settings card without a drafted name to read", () => {
    const card = presentProposalCard(proposalRow({
      targetType: "ingestion_settings",
      targetRef: {},
      payload: { name: "Ingestion settings", chunkingStrategy: "fixed_window", fixedWindowChunkSize: 1_500 },
    }) as never);

    expect(card.targetLabel).not.toBe("");
    expect(card.removal).toBeUndefined();
  });

  it("labels a reloaded crawl card by the url it would crawl", () => {
    const card = presentProposalCard(proposalRow({
      targetType: "website_crawl",
      targetRef: { url: "https://help.example.com" },
      payload: { name: "https://help.example.com", url: "https://help.example.com", limit: 25 },
    }) as never);

    expect(card.targetLabel).toBe("https://help.example.com");
  });

  it("still reads a directive removal written before cards were stored", () => {
    const card = presentProposalCard(proposalRow({
      targetType: "directive",
      targetRef: { agentId: "agent-1", directiveId: "directive-1" },
      payload: { op: "remove", name: "Do not guess", rationale: "Superseded." },
    }) as never);

    expect(card.targetLabel).toBe("Do not guess");
    expect(card.removal).toBe(true);
    expect(card.summary).toBe("Superseded.");
  });
});
