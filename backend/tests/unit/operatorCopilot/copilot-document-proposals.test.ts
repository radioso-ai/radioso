import { describe, expect, it, vi } from "vitest";

import { createDocumentCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/documentProposalAdapter.js";
import { createDocumentProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/documentProposals.js";
import { conflict } from "../../../src/shared/domain/errors.js";

const DOCUMENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  copilotConversationId: "conversation-1",
  pageContext: { view: "documents" as const, agentId: null, conversationId: null, selection: null, entities: [] },
};

const storedDocument = (overrides: Record<string, unknown> = {}) => ({
  id: DOCUMENT_ID,
  title: "Refund policy",
  status: "ready",
  metadata: { language: "en" } as Record<string, unknown>,
  retrievalEnabled: true,
  retrievalExpiresAt: null as Date | null,
  updatedAt: new Date("2026-08-30T10:00:00.000Z"),
  ...overrides,
});

const authoringPorts = (document = storedDocument()) => ({
  getDocument: vi.fn(async () => document),
  ingest: vi.fn(async () => ({ documentId: DOCUMENT_ID })),
  updateRetrievalSettings: vi.fn(async () => document),
});

const deletionPort = () => ({ delete: vi.fn(async () => undefined) });

const workspaceAccount = () => ({ resolveAccountId: vi.fn(async () => "account-1") });

const adapterFor = (
  authoring = authoringPorts(),
  deletion = deletionPort(),
  account = workspaceAccount(),
) => ({
  adapter: createDocumentCopilotProposalAdapter({
    documentAuthoring: authoring,
    documentDeletion: deletion,
    workspaceAccount: account,
  }),
  authoring,
  deletion,
  account,
});

const toolDeps = (adapter: ReturnType<typeof createDocumentCopilotProposalAdapter>) => {
  const createProposal = vi.fn(async (input: Record<string, unknown>) => ({
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    ...input,
  }) as never);
  const record = vi.fn(async () => undefined);
  return {
    createProposal,
    record,
    deps: {
      proposalRepository: { createProposal },
      proposalAdapters: [adapter],
      auditService: { record },
    },
  };
};

const toolNamed = (
  name: string,
  adapter: ReturnType<typeof createDocumentCopilotProposalAdapter>,
) => {
  const { deps, createProposal, record } = toolDeps(adapter);
  const descriptor = createDocumentProposalCopilotTools(deps).find((candidate) => candidate.name === name);
  if (!descriptor) throw new Error(`No descriptor named ${name}`);
  return { descriptor, createProposal, record };
};

describe("propose_document", () => {
  it("drafts a create proposal that carries the authored title and body", async () => {
    const { adapter } = adapterFor();
    const { descriptor, createProposal, record } = toolNamed("propose_document", adapter);

    const result = await descriptor.createTool(context).invoke({
      title: "Refund window",
      content: "Refunds are accepted within 30 days of delivery.",
      metadata: { language: "en" },
      rationale: "The agent could not answer how long customers have to return an order.",
    }, {} as never) as { proposalId: string; targetType: string; targetLabel: string; summary: string };

    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      operatorUserId: "operator-1",
      conversationId: "conversation-1",
      targetType: "document",
      targetRef: { documentId: null },
      payload: expect.objectContaining({
        op: "create",
        name: "Refund window",
        content: "Refunds are accepted within 30 days of delivery.",
        metadata: { language: "en" },
      }),
    }));
    expect(result.targetType).toBe("document");
    expect(result.targetLabel).toBe("Refund window");
    expect(result.summary).toContain("Refund window");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ eventType: "copilot.proposal.created" }));
  });

  it("has no field for an external document id, so a create can never silently replace an existing document", () => {
    const { adapter } = adapterFor();
    const { descriptor } = toolNamed("propose_document", adapter);

    expect(descriptor.inputSchema.safeParse({
      title: "Refund window",
      content: "Refunds are accepted within 30 days.",
      externalDocumentId: "crm-4711",
    }).success).toBe(false);
  });

  it("refuses to draft a create whose body is not supplied", async () => {
    const { adapter } = adapterFor();
    const { descriptor } = toolNamed("propose_document", adapter);

    expect(descriptor.inputSchema.safeParse({ title: "Refund window" }).success).toBe(false);
  });
});

describe("propose_document_retrieval", () => {
  it("drafts a metadata and retrieval-eligibility change against the stored document", async () => {
    const { adapter, authoring } = adapterFor();
    const { descriptor, createProposal } = toolNamed("propose_document_retrieval", adapter);

    const result = await descriptor.createTool(context).invoke({
      documentId: DOCUMENT_ID,
      retrievalEnabled: false,
      rationale: "It contradicts the newer policy document.",
    }, {} as never) as { targetLabel: string; summary: string; removal?: boolean };

    expect(authoring.getDocument).toHaveBeenCalledWith("workspace-1", DOCUMENT_ID);
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "document",
      targetRef: { documentId: DOCUMENT_ID },
      payload: expect.objectContaining({ op: "update_retrieval", retrievalEnabled: false, name: "Refund policy" }),
      versionToken: "2026-08-30T10:00:00.000Z",
    }));
    expect(result.targetLabel).toBe("Refund policy");
    expect(result.removal).toBeUndefined();
  });

  it("carries no document body field at all, because Ray only ever sees snippets and chunks", () => {
    const { adapter } = adapterFor();
    const { descriptor } = toolNamed("propose_document_retrieval", adapter);

    expect(descriptor.inputSchema.safeParse({
      documentId: DOCUMENT_ID,
      content: "A rewritten body Ray never read in full.",
    }).success).toBe(false);
  });

  it("refuses a change that names no field to change", async () => {
    const { adapter } = adapterFor();
    const { descriptor } = toolNamed("propose_document_retrieval", adapter);

    await expect(descriptor.createTool(context).invoke({ documentId: DOCUMENT_ID }, {} as never))
      .rejects.toThrow(/retrievalEnabled|retrievalExpiresAt|metadata/);
  });
});

describe("propose_document_removal", () => {
  it("marks the card as a removal and states that it cannot be undone", async () => {
    const { adapter } = adapterFor();
    const { descriptor, createProposal } = toolNamed("propose_document_removal", adapter);

    const result = await descriptor.createTool(context).invoke({
      documentId: DOCUMENT_ID,
      rationale: "Superseded by the 2026 policy.",
    }, {} as never) as { targetLabel: string; summary: string; removal?: boolean };

    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "document",
      targetRef: { documentId: DOCUMENT_ID },
      payload: expect.objectContaining({ op: "delete", name: "Refund policy", removesTarget: true }),
    }));
    expect(result.removal).toBe(true);
    expect(result.summary).toContain("cannot be undone");
  });

  it("fails when the document does not exist rather than proposing to remove nothing", async () => {
    const authoring = authoringPorts();
    authoring.getDocument.mockRejectedValueOnce(new Error("Document not found"));
    const { adapter } = adapterFor(authoring);
    const { descriptor, createProposal } = toolNamed("propose_document_removal", adapter);

    await expect(descriptor.createTool(context).invoke({ documentId: DOCUMENT_ID }, {} as never))
      .rejects.toThrow("Document not found");
    expect(createProposal).not.toHaveBeenCalled();
  });
});

  it("previews an expiry the write would clear as cleared, not as the date that was asked for", async () => {
    // Enabling retrieval with an expiry already in the past clears it, so showing the requested date
    // would promise an eligibility window the document never comes back with.
    const { adapter } = adapterFor();

    const preview = await adapter.preview("workspace-1", { documentId: DOCUMENT_ID }, {
      op: "update_retrieval", name: "Refund policy", retrievalEnabled: true, retrievalExpiresAt: "2020-01-01T00:00:00.000Z",
    });

    expect(preview.proposed).toMatchObject({ retrievalEnabled: true, retrievalExpiresAt: null });
  });

describe("document proposal adapter", () => {
  it("creates the document through the ingestion port with the workspace's account", async () => {
    const { adapter, authoring, account } = adapterFor();

    const outcome = await adapter.applyIfVersionMatches("workspace-1", { documentId: null }, {
      op: "create", name: "Refund window", content: "Within 30 days.", metadata: { language: "en" },
    }, "create");

    expect(account.resolveAccountId).toHaveBeenCalledWith("workspace-1");
    expect(authoring.ingest).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      accountId: "account-1",
      title: "Refund window",
      content: "Within 30 days.",
      metadata: { language: "en" },
    });
    expect(outcome).toEqual({ outcome: "applied", appliedRef: { documentId: DOCUMENT_ID } });
  });

  // The draft's version is the write's own predicate, not something this adapter compares first,
  // so the refusal it has to translate arrives as a conflict from the owning service.
  it("reports a retrieval change as stale when the write refuses the version the draft carried", async () => {
    const authoring = authoringPorts();
    authoring.updateRetrievalSettings = vi.fn(async () => {
      throw conflict("Document was updated by another writer; reload before saving again");
    });
    const { adapter } = adapterFor(authoring);

    const outcome = await adapter.applyIfVersionMatches("workspace-1", { documentId: DOCUMENT_ID }, {
      op: "update_retrieval", name: "Refund policy", retrievalEnabled: false,
    }, "2026-08-01T10:00:00.000Z");

    expect(outcome).toEqual({ outcome: "stale" });
  });

  it("settles metadata and eligibility in one write that carries the drafted version", async () => {
    const { adapter, authoring } = adapterFor();

    const outcome = await adapter.applyIfVersionMatches("workspace-1", { documentId: DOCUMENT_ID }, {
      op: "update_retrieval", name: "Refund policy", metadata: { language: "de" }, retrievalEnabled: false,
    }, "2026-08-30T10:00:00.000Z");

    expect(authoring.updateRetrievalSettings).toHaveBeenCalledTimes(1);
    expect(authoring.updateRetrievalSettings).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      documentId: DOCUMENT_ID,
      expectedUpdatedAt: new Date("2026-08-30T10:00:00.000Z"),
      metadata: { language: "de" },
      retrievalEnabled: false,
    });
    expect(outcome).toEqual({ outcome: "applied", appliedRef: { documentId: DOCUMENT_ID } });
  });

  it("deletes under the version the draft was made against", async () => {
    const { adapter, deletion } = adapterFor();

    const applied = await adapter.applyIfVersionMatches("workspace-1", { documentId: DOCUMENT_ID }, { op: "delete", name: "Refund policy", removesTarget: true }, "2026-08-30T10:00:00.000Z");

    expect(applied).toEqual({ outcome: "applied", appliedRef: { documentId: DOCUMENT_ID } });
    expect(deletion.delete).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      documentId: DOCUMENT_ID,
      expectedUpdatedAt: new Date("2026-08-30T10:00:00.000Z"),
    });
  });

  it("reports a delete the document has already moved under as stale", async () => {
    const deletion = { delete: vi.fn(async () => { throw conflict("Document was updated by another writer; reload before saving again"); }) };
    const { adapter } = adapterFor(authoringPorts(), deletion);

    const outcome = await adapter.applyIfVersionMatches("workspace-1", { documentId: DOCUMENT_ID }, { op: "delete", name: "Refund policy", removesTarget: true }, "2026-08-01T10:00:00.000Z");

    expect(outcome).toEqual({ outcome: "stale" });
  });

  // A create leaves nothing behind that a second attempt could recognise, so the adapter has to
  // say so and let the service refuse the retry rather than ingesting the document twice.
  it("declares that a create cannot be retried after an interrupted apply", async () => {
    const { adapter } = adapterFor();

    expect(adapter.canRetryAfterInterruptedApply?.({ documentId: null }, { op: "create", name: "Refund window", content: "Within 30 days." })).toBe(false);
    expect(adapter.canRetryAfterInterruptedApply?.({ documentId: DOCUMENT_ID }, { op: "update_retrieval", name: "Refund policy", retrievalEnabled: false })).toBe(true);
  });

  it("previews the stored retrieval state without ever reading the document body", async () => {
    const { adapter } = adapterFor();

    const preview = await adapter.preview("workspace-1", { documentId: DOCUMENT_ID }, {
      op: "update_retrieval", name: "Refund policy", retrievalEnabled: false,
    });

    expect(preview.targetLabel).toBe("Refund policy");
    expect(preview.current).toEqual({ name: "Refund policy", metadata: { language: "en" }, retrievalEnabled: true, retrievalExpiresAt: null });
    expect(preview.proposed).toEqual({ name: "Refund policy", metadata: { language: "en" }, retrievalEnabled: false, retrievalExpiresAt: null });
    expect(JSON.stringify(preview)).not.toContain("content");
  });

  it("keeps a create's version token free of any existing row's timestamp", async () => {
    const { adapter, authoring } = adapterFor();

    const token = await adapter.readVersionToken("workspace-1", { documentId: null }, { op: "create", name: "Refund window", content: "Within 30 days." });

    expect(token).toBe("create");
    expect(authoring.getDocument).not.toHaveBeenCalled();
  });
});
