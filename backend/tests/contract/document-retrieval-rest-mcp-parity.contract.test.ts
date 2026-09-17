import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createCopilotDocumentAuthoringPort } from "../../src/app/composition/copilotToolCatalog.js";
import { createDocumentCopilotProposalAdapter } from "../../src/modules/operatorCopilot/documentProposalAdapter.js";
import { createDocumentProposalCopilotTools } from "../../src/modules/operatorCopilot/tools/documentProposals.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

/**
 * Proves that `PATCH /api/v1/document/:id` (REST) and `propose_document_retrieval` applied through
 * `documentProposalAdapter.applyIfVersionMatches` (the same call `execute_reviewed_proposal` makes)
 * reach identical outcomes, because both paths write through the same
 * `DocumentIngestionService.updateRetrievalSettings`. Two documents in the same workspace take the
 * same sequence of changes through each path so the results can be compared directly rather than
 * inferred from reading the source twice.
 */
describe("document retrieval settings: the REST route and the document proposal adapter apply the same change", () => {
  const setup = async () => {
    const { app, dependencies, repositories } = createTestApp();
    const session = await issueTestSession(app, `parity-${randomUUID()}@example.com`);
    const headers = adminSessionHeaders(session);

    const createDocument = async (title: string): Promise<string> => {
      const response = await request(app)
        .post("/api/v1/document/")
        .set(headers)
        .send({ title, content: `Body for ${title}.` })
        .expect(202);
      return response.body.documentId as string;
    };

    const documentIdRest = await createDocument("REST-path document");
    const documentIdMcp = await createDocument("MCP-path document");

    const documentAuthoring = createCopilotDocumentAuthoringPort(dependencies.documentIngestionService);
    const adapter = createDocumentCopilotProposalAdapter({
      documentAuthoring,
      documentDeletion: { delete: vi.fn() },
      workspaceAccount: { resolveAccountId: vi.fn(async () => session.accountId) },
    });
    const createProposal = vi.fn(async (input: Record<string, unknown>) => ({
      id: randomUUID(),
      ...input,
    }) as never);
    const descriptor = createDocumentProposalCopilotTools({
      proposalRepository: { createProposal },
      proposalRecovery: { recoverOperatorMcpProposal: vi.fn() },
      proposalAdapters: [adapter],
      auditService: { record: vi.fn() },
    }).find((candidate) => candidate.name === "propose_document_retrieval");
    if (!descriptor) throw new Error("No propose_document_retrieval descriptor");

    const mcpContext = {
      workspaceId: session.workspaceId,
      accountId: session.accountId,
      operatorUserId: session.userId,
      surface: "mcp" as const,
      currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
      copilotConversationId: undefined,
      operatorMcpInvocationId: randomUUID(),
      pageContext: { view: "documents" as const, agentId: null, conversationId: null, selection: null, entities: [] },
    };

    // Draft through the MCP tool, then apply the drafted payload the same way
    // `execute_reviewed_proposal` -> `adapter.applyIfVersionMatches` does, rather than through the
    // proposal-review machinery this test is not exercising.
    const applyThroughMcp = async (input: {
      retrievalEnabled?: boolean;
      retrievalExpiresAt?: string | null;
      metadata?: Record<string, unknown>;
    }): Promise<void> => {
      await descriptor.createTool(mcpContext).invoke({ documentId: documentIdMcp, ...input }, {} as never);
      const draft = createProposal.mock.calls.at(-1)?.[0] as { targetRef: unknown; payload: unknown; versionToken: string };
      const outcome = await adapter.applyIfVersionMatches(session.workspaceId, draft.targetRef, draft.payload, draft.versionToken);
      expect(outcome).toMatchObject({ outcome: "applied" });
    };

    const applyThroughRest = async (input: {
      retrievalEnabled?: boolean;
      retrievalExpiresAt?: string | null;
      metadata?: Record<string, unknown>;
    }): Promise<void> => {
      await request(app).patch(`/api/v1/document/${documentIdRest}`).set(headers).send(input).expect(200);
    };

    const readDocument = async (documentId: string) =>
      (await request(app).get(`/api/v1/document/${documentId}`).set(headers).expect(200)).body as {
        retrievalEnabled: boolean;
        retrievalExpiresAt: string | null;
        metadata: Record<string, unknown>;
      };

    const eventTypesFor = (documentId: string) =>
      repositories.auditEventRepository.items
        .filter((event) => event.eventType === "document.retrieval.update" && event.metadata.documentId === documentId)
        .map((event) => event.eventType);

    return { app, documentIdRest, documentIdMcp, applyThroughMcp, applyThroughRest, readDocument, eventTypesFor };
  };

  it("auto-excludes a document identically on both paths when a future retrievalExpiresAt is set", async () => {
    const { documentIdRest, documentIdMcp, applyThroughMcp, applyThroughRest, readDocument, eventTypesFor } = await setup();
    const future = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const metadata = { tier: "gold" };

    await applyThroughRest({ retrievalExpiresAt: future, metadata });
    await applyThroughMcp({ retrievalExpiresAt: future, metadata });

    const restDocument = await readDocument(documentIdRest);
    const mcpDocument = await readDocument(documentIdMcp);

    expect(mcpDocument.retrievalEnabled).toBe(restDocument.retrievalEnabled);
    expect(mcpDocument.retrievalExpiresAt).toBe(restDocument.retrievalExpiresAt);
    expect(mcpDocument.metadata).toEqual(restDocument.metadata);
    expect(restDocument.retrievalExpiresAt).toBe(future);

    expect(eventTypesFor(documentIdMcp)).toEqual(eventTypesFor(documentIdRest));
    expect(eventTypesFor(documentIdRest)).toEqual(["document.retrieval.update"]);
  });

  it("clears an already-elapsed expiry identically on both paths when retrieval is re-enabled", async () => {
    const { documentIdRest, documentIdMcp, applyThroughMcp, applyThroughRest, readDocument, eventTypesFor } = await setup();
    const elapsed = new Date(Date.now() - 60_000).toISOString();

    await applyThroughRest({ retrievalEnabled: true, retrievalExpiresAt: elapsed });
    await applyThroughMcp({ retrievalEnabled: true, retrievalExpiresAt: elapsed });

    const restDocument = await readDocument(documentIdRest);
    const mcpDocument = await readDocument(documentIdMcp);

    expect(restDocument.retrievalEnabled).toBe(true);
    expect(restDocument.retrievalExpiresAt).toBeNull();
    expect(mcpDocument.retrievalEnabled).toBe(restDocument.retrievalEnabled);
    expect(mcpDocument.retrievalExpiresAt).toBe(restDocument.retrievalExpiresAt);

    expect(eventTypesFor(documentIdMcp)).toEqual(eventTypesFor(documentIdRest));
    expect(eventTypesFor(documentIdRest)).toEqual(["document.retrieval.update"]);
  });
});
