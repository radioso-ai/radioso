import { describe, expect, it, vi } from "vitest";

import { notFound } from "../../../src/shared/domain/errors.js";

import { copilotProposalPermissions } from "../../../src/modules/operatorCopilot/contracts.js";
import { presentProposalCard } from "../../../src/db/repositories/copilotRepository.js";
import { OperatorCopilotService } from "../../../src/modules/operatorCopilot/service.js";
import { createDocumentProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/documentProposals.js";
import { createDocumentCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/documentProposalAdapter.js";
import { createIngestionSettingsProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/ingestionSettingsProposals.js";
import { createIngestionSettingsCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/ingestionSettingsProposalAdapter.js";
import { createWebsiteCrawlProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/websiteCrawlProposals.js";
import { createWebsiteCrawlCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/websiteCrawlProposalAdapter.js";
import { createCopilotDocumentAuthoringPort } from "../../../src/app/composition/copilotToolCatalog.js";

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

/**
 * The sentence a card states has two producers: the tool's own output drives the live card, and
 * `presentProposalCard` re-derives one from the stored payload after a reload. They drifted apart
 * once already, so this holds them to the same string per target type.
 */
describe("live and reloaded cards state the same thing", () => {
  const toolContext = {
    workspaceId: "workspace-1",
    accountId: "account-1",
    operatorUserId: "operator-1",
    currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
    copilotConversationId: "conversation-1",
    pageContext: { view: "documents" as const, agentId: null, conversationId: null, selection: null, entities: [] },
  };

  const drafted = async (
    descriptors: ReadonlyArray<{ name: string; createTool: (context: never) => { invoke: (input: unknown, extra: never) => Promise<unknown> } }>,
    name: string,
    input: unknown,
    createProposal: { mock: { calls: unknown[][] } },
  ) => {
    const descriptor = descriptors.find((candidate) => candidate.name === name);
    if (!descriptor) throw new Error(`No descriptor named ${name}`);
    const live = await descriptor.createTool(toolContext as never).invoke(input, {} as never) as { targetLabel: string; summary: string; removal?: boolean };
    const persisted = createProposal.mock.calls[0]![0] as Record<string, unknown>;
    const reloaded = presentProposalCard({ ...persisted, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", status: "pending", reason: null, appliedRef: null, messageId: null, createdAt: new Date(), updatedAt: new Date(), evidence: null } as never);
    return { live, reloaded };
  };

  const recorder = () => {
    const createProposal = vi.fn(async (input: Record<string, unknown>) => ({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", ...input }) as never);
    return { createProposal, deps: { proposalRepository: { createProposal }, auditService: { record: vi.fn(async () => undefined) } } };
  };

  const documentPorts = () => ({
    getDocument: vi.fn(async () => ({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", title: "Refund policy", status: "ready",
      metadata: {}, retrievalEnabled: true, retrievalExpiresAt: null, updatedAt: new Date("2026-08-30T10:00:00.000Z"),
    })),
    ingest: vi.fn(), updateMetadata: vi.fn(), updateRetrievalEligibility: vi.fn(),
  });

  it("agrees for a document removal", async () => {
    const { createProposal, deps } = recorder();
    const adapter = createDocumentCopilotProposalAdapter({ documentAuthoring: documentPorts(), documentDeletion: { delete: vi.fn() }, workspaceAccount: { resolveAccountId: vi.fn(async () => "account-1") } });
    const { live, reloaded } = await drafted(createDocumentProposalCopilotTools({ ...deps, proposalAdapters: [adapter] }) as never, "propose_document_removal", { documentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, createProposal);

    expect(reloaded.summary).toBe(live.summary);
    expect(reloaded.targetLabel).toBe(live.targetLabel);
    expect(reloaded.removal).toBe(true);
  });

  it("agrees for an ingestion settings change", async () => {
    const { createProposal, deps } = recorder();
    const adapter = createIngestionSettingsCopilotProposalAdapter({
      ingestionSettings: {
        getForWorkspace: vi.fn(async () => ({
          chunkingStrategy: "fixed_window", fixedWindowChunkSize: 1_000, fixedWindowChunkOverlap: 100,
          structuredMinChunkSize: 200, structuredMaxChunkSize: 2_000, updatedAt: new Date("2026-08-30T10:00:00.000Z"),
        })),
        updateForWorkspace: vi.fn(),
      },
    });
    const { live, reloaded } = await drafted(createIngestionSettingsProposalCopilotTools({ ...deps, proposalAdapters: [adapter] }) as never, "propose_ingestion_settings", { fixedWindowChunkSize: 1_500 }, createProposal);

    expect(reloaded.summary).toBe(live.summary);
    expect(reloaded.targetLabel).toBe(live.targetLabel);
  });

  it("agrees for a website crawl", async () => {
    const { createProposal, deps } = recorder();
    const adapter = createWebsiteCrawlCopilotProposalAdapter({
      websiteCrawl: { assertCrawlUrlAllowed: vi.fn(async () => undefined), enqueue: vi.fn() },
      workspaceAccount: { resolveAccountId: vi.fn(async () => "account-1") },
      crawlPolicy: () => ({ enabled: true, defaultLimit: 50, maxLimit: 200 }),
    });
    const { live, reloaded } = await drafted(createWebsiteCrawlProposalCopilotTools({ ...deps, proposalAdapters: [adapter] }) as never, "start_crawl", { url: "https://help.example.com" }, createProposal);

    expect(reloaded.summary).toBe(live.summary);
    expect(reloaded.targetLabel).toBe(live.targetLabel);
  });
});

describe("failure modes the adapters must tell apart", () => {
  const storedDocument = {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", title: "Refund policy", status: "ready",
    metadata: {}, retrievalEnabled: true, retrievalExpiresAt: null, updatedAt: new Date("2026-08-30T10:00:00.000Z"),
  };
  const documentAdapter = (getDocument: () => Promise<typeof storedDocument>) => createDocumentCopilotProposalAdapter({
    documentAuthoring: { getDocument, ingest: vi.fn(), updateMetadata: vi.fn(), updateRetrievalEligibility: vi.fn() },
    documentDeletion: { delete: vi.fn() },
    workspaceAccount: { resolveAccountId: vi.fn(async () => "account-1") },
  });
  const deletePayload = { op: "delete" as const, name: "Refund policy", removesTarget: true as const };

  it("reads a deleted document as a stale proposal", async () => {
    const adapter = documentAdapter(async () => { throw notFound("Document not found"); });

    await expect(adapter.applyIfVersionMatches("workspace-1", { documentId: storedDocument.id }, deletePayload, "2026-08-30T10:00:00.000Z"))
      .resolves.toEqual({ outcome: "stale" });
  });

  it("reads a database failure as a failure, not as a document someone deleted", async () => {
    const adapter = documentAdapter(async () => { throw new Error("connection terminated unexpectedly"); });

    const outcome = await adapter.applyIfVersionMatches("workspace-1", { documentId: storedDocument.id }, deletePayload, "2026-08-30T10:00:00.000Z");

    expect(outcome).toEqual({ outcome: "failed", reason: "connection terminated unexpectedly" });
  });

  it("lets a database failure surface from preview instead of showing an empty current state", async () => {
    const adapter = documentAdapter(async () => { throw new Error("connection terminated unexpectedly"); });

    await expect(adapter.preview("workspace-1", { documentId: storedDocument.id }, deletePayload))
      .rejects.toThrow("connection terminated unexpectedly");
  });

  it("refuses an ingestion change whose merged result the settings domain rejects", async () => {
    // Each field is individually in range; the combination is not, and only the domain knows that.
    const adapter = createIngestionSettingsCopilotProposalAdapter({
      ingestionSettings: {
        getForWorkspace: vi.fn(async () => ({
          chunkingStrategy: "fixed_window", fixedWindowChunkSize: 1_000, fixedWindowChunkOverlap: 100,
          structuredMinChunkSize: 200, structuredMaxChunkSize: 2_000, updatedAt: new Date("2026-08-30T10:00:00.000Z"),
        })),
        updateForWorkspace: vi.fn(),
      },
    });

    await expect(adapter.validatePayload("workspace-1", {}, { fixedWindowChunkOverlap: 900, fixedWindowChunkSize: 500 }))
      .rejects.toThrow(/smaller than/i);
  });

  it("applies a crawl under the policy in force at apply, not the one it was drafted under", async () => {
    const enqueue = vi.fn(async () => ({ jobId: "job-1", sourceId: "source-1" }));
    let policy = { enabled: true, defaultLimit: 50, maxLimit: 200 };
    const adapter = createWebsiteCrawlCopilotProposalAdapter({
      websiteCrawl: { assertCrawlUrlAllowed: vi.fn(async () => undefined), enqueue },
      workspaceAccount: { resolveAccountId: vi.fn(async () => "account-1") },
      crawlPolicy: () => policy,
    });

    const drafted = await adapter.validatePayload("workspace-1", { url: "https://help.example.com" }, { url: "https://help.example.com", limit: 200 });
    policy = { enabled: true, defaultLimit: 10, maxLimit: 25 };
    await adapter.applyIfVersionMatches("workspace-1", drafted.targetRef, drafted.payload, drafted.versionToken);

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
  });
});

describe("the composed document port", () => {
  it("hands the adapter a document with no body, whatever the ingestion service returned", async () => {
    // The port's type omits `content`, but a type is a compile-time claim. This proves the object
    // itself has no body, so a widening cast or a JSON dump downstream cannot leak one.
    const port = createCopilotDocumentAuthoringPort({
      getDocument: async () => ({
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        title: "Refund policy",
        status: "ready",
        metadata: {},
        retrievalEnabled: true,
        retrievalExpiresAt: null,
        updatedAt: new Date("2026-08-30T10:00:00.000Z"),
        content: "The entire stored body of the document.",
      }) as never,
      ingest: vi.fn(),
      updateMetadata: vi.fn(),
      updateRetrievalEligibility: vi.fn(),
    });

    const document = await port.getDocument("workspace-1", "dddddddd-dddd-4ddd-8ddd-dddddddddddd");

    expect(Object.keys(document)).not.toContain("content");
    expect(JSON.stringify(document)).not.toContain("entire stored body");
  });
});
