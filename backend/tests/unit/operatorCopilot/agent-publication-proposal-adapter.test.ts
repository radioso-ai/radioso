import { describe, expect, it, vi } from "vitest";

import { createAgentPublicationProposalAdapter } from "../../../src/modules/operatorCopilot/agentPublicationProposalAdapter.js";

const target = { agentId: "00000000-0000-4000-8000-000000000001", candidateRevisionId: "00000000-0000-4000-8000-000000000002" };
const payload = { expectedDraftGeneration: 4, expectedPublishedRevisionId: "00000000-0000-4000-8000-000000000003" };
const state = { draft: { generation: 4, basePublishedRevisionId: payload.expectedPublishedRevisionId }, publishedRevision: { id: payload.expectedPublishedRevisionId } };
const context = { surface: "mcp" as const, accountId: "account-1", executionInvocationId: "execution-1" };

describe("agent publication reviewed proposal adapter", () => {
  it("validates the immutable candidate and derives its publication fence", async () => {
    const detail = vi.fn().mockResolvedValue({ id: target.candidateRevisionId });
    const adapter = createAgentPublicationProposalAdapter({ revisions: { state: vi.fn(), detail, publish: vi.fn() } });
    await expect(adapter.validatePayload(target.agentId, target, payload)).resolves.toEqual({ targetRef: target, payload, versionToken: `4:${payload.expectedPublishedRevisionId}` });
    expect(detail).toHaveBeenCalledWith(target.agentId, target.agentId, target.candidateRevisionId);
  });

  it("publishes once using the execution receipt as the owner idempotency key", async () => {
    const publish = vi.fn().mockResolvedValue({ publicationId: "publication-1", revisionId: target.candidateRevisionId, publishedAt: new Date(), idempotentReplay: false });
    const adapter = createAgentPublicationProposalAdapter({ revisions: { state: vi.fn().mockResolvedValue(state), detail: vi.fn(), publish } });
    await expect(adapter.applyIfVersionMatches("workspace-1", target, payload, `4:${payload.expectedPublishedRevisionId}`, context)).resolves.toMatchObject({ outcome: "applied", appliedRef: { publicationId: "publication-1", revisionId: target.candidateRevisionId } });
    expect(publish).toHaveBeenCalledWith("workspace-1", target.agentId, "account-1", expect.objectContaining({ idempotencyKey: "execution-1" }));
  });

  it("lets the owner resolve a changed fence as a stale publication", async () => {
    const publish = vi.fn().mockRejectedValue({ statusCode: 409 });
    const adapter = createAgentPublicationProposalAdapter({ revisions: { state: vi.fn().mockResolvedValue({ ...state, draft: { ...state.draft, generation: 5 } }), detail: vi.fn(), publish } });
    await expect(adapter.applyIfVersionMatches("workspace-1", target, payload, `4:${payload.expectedPublishedRevisionId}`, context)).resolves.toEqual({ outcome: "stale" });
    expect(publish).toHaveBeenCalledOnce();
  });

  it("reconciles a lost response through the owner's execution idempotency record", async () => {
    const publishedAt = new Date();
    const publish = vi.fn().mockResolvedValue({ publicationId: "publication-1", revisionId: target.candidateRevisionId, publishedAt, idempotentReplay: true });
    const adapter = createAgentPublicationProposalAdapter({ revisions: { state: vi.fn().mockResolvedValue({ ...state, draft: { ...state.draft, generation: 5 } }), detail: vi.fn(), publish } });

    await expect(adapter.reconcileMcpInterruptedApply?.({ workspaceId: "workspace-1", accountId: "account-1", targetRef: target, payload, versionToken: `4:${payload.expectedPublishedRevisionId}`, executionInvocationId: "execution-1", previousAttemptStartedAt: new Date() }))
      .resolves.toEqual({ outcome: "applied", appliedRef: { publicationId: "publication-1", revisionId: target.candidateRevisionId, publishedAt } });
    expect(publish).toHaveBeenCalledWith("workspace-1", target.agentId, "account-1", expect.objectContaining({ idempotencyKey: "execution-1" }));
  });

  it("does not permit dashboard application of a reviewed publication", async () => {
    const adapter = createAgentPublicationProposalAdapter({ revisions: { state: vi.fn(), detail: vi.fn(), publish: vi.fn() } });
    await expect(adapter.applyIfVersionMatches("workspace-1", target, payload, `4:${payload.expectedPublishedRevisionId}`, { surface: "dashboard", accountId: "account-1" })).resolves.toMatchObject({ outcome: "failed" });
  });
});
