import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { OperatorMcpCatalogService } from "../../../src/modules/operatorCopilot/mcpCatalog.js";
import { operatorMcpDispositions } from "../../../src/modules/operatorCopilot/operatorMcpDisposition.js";
import { createReviewedProposalOutcomeTool } from "../../../src/modules/operatorCopilot/tools/reviewedProposalOutcome.js";
import { createDocumentReviewedOperationTools } from "../../../src/modules/operatorCopilot/tools/documentReviewedOperations.js";

const currentAuthorization = { hasAllPermissions: vi.fn(async () => true) };
const context = {
  workspaceId: randomUUID(), accountId: randomUUID(), operatorUserId: randomUUID(), surface: "mcp" as const,
  permissions: new Set(["workspace.documents.manage"]), currentAuthorization,
  operatorMcpInvocationId: randomUUID(), operatorMcpGrantId: randomUUID(), operatorMcpClientId: randomUUID(),
  pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
};

describe("reviewed document operations through the MCP catalog", () => {
  it("validates and projects every prepare operation, and reads a structured partial outcome", async () => {
    const proposalId = randomUUID();
    const now = new Date("2026-09-26T00:00:00.000Z");
    const operations = {
      prepareImport: vi.fn(async () => ({ operation: "import" as const, documents: [{ externalDocumentId: "law-1", title: "Law", content: "text", contentHash: "a".repeat(64), expectedDocumentId: null, expectedRevision: null, expectedContentHash: null, indexedBytes: 4, storageDeltaBytes: 4, action: "create" as const }], fence: "fence" })),
      prepareRemoval: vi.fn(async () => ({ operation: "removal" as const, documents: [{ id: randomUUID(), title: "Law", updatedAt: now.toISOString() }], unknownIds: [], fence: "fence" })),
      prepareReprocess: vi.fn(async () => ({ operation: "reprocess" as const, documents: [{ id: randomUUID(), updatedAt: now.toISOString(), status: "ready" }], fence: "fence" })),
    };
    const prepare = createDocumentReviewedOperationTools({
      documents: operations,
      proposalRecovery: { recoverOperatorMcpProposal: vi.fn() },
      proposalRepository: { createProposal: vi.fn(async () => ({ id: proposalId })) } as never,
      proposalAdapters: [], auditService: { record: vi.fn() }, now: () => now,
    }).map((descriptor) => ({ ...descriptor, mcpDisposition: operatorMcpDispositions[descriptor.name] }));
    const outcome = createReviewedProposalOutcomeTool({
      getMcpReviewedProposal: vi.fn(async () => ({ proposal: { id: proposalId, status: "applied" as const, reviewDigest: "digest", expiresAt: now, appliedRef: { counts: { created: 1, replaced: 0, unchanged: 0, failed: 1 }, failures: [{ externalDocumentId: "law-2", code: "usage_limit_exceeded" }] }, reviewSnapshot: { review: { counts: {} }, fullReview: { documents: [] } } }, currentVersionMatches: true })),
    });
    const catalog = new OperatorMcpCatalogService([...prepare, { ...outcome, mcpDisposition: operatorMcpDispositions.reviewed_proposal_outcome }]);
    const invoke = (name: string, arguments_: unknown) => catalog.invoke({ name, arguments: arguments_, context, scopes: new Set(["operator:propose", "operator:write"]), signal: AbortSignal.timeout(1_000) });

    await expect(invoke("prepare_document_import", { documents: [{ externalDocumentId: "law-1", title: "Law", content: "text" }] })).resolves.toMatchObject({ proposalId });
    await expect(invoke("prepare_document_removal", { documentIds: [randomUUID()] })).resolves.toMatchObject({ proposalId });
    await expect(invoke("prepare_document_reprocess", { kind: "all", all: true })).resolves.toMatchObject({ proposalId });
    await expect(invoke("reviewed_proposal_outcome", { proposalId })).resolves.toMatchObject({ appliedRef: { counts: { failed: 1 }, failures: [{ code: "usage_limit_exceeded" }] } });
  });
});
