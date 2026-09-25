import { describe, expect, it, vi } from "vitest";

import { createAgentPublicationProposalAdapter, type AgentPublicationRevisionPort } from "../../../src/modules/operatorCopilot/agentPublicationProposalAdapter.js";
import { AppError } from "../../../src/shared/domain/errors.js";

const target = { agentId: "00000000-0000-4000-8000-000000000001", candidateRevisionId: "00000000-0000-4000-8000-000000000002" };
const payload = { expectedDraftGeneration: 4, expectedPublishedRevisionId: "00000000-0000-4000-8000-000000000003" };
const state = { draft: { generation: 4, basePublishedRevisionId: payload.expectedPublishedRevisionId }, publishedRevision: { id: payload.expectedPublishedRevisionId } };
const context = { surface: "mcp" as const, accountId: "account-1", executionInvocationId: "execution-1" };
const revisionPort = (overrides: Partial<AgentPublicationRevisionPort>): AgentPublicationRevisionPort => ({
  state: vi.fn(), createCandidate: vi.fn(), detail: vi.fn(), describeCandidateRelease: vi.fn(), readCandidateReleaseChange: vi.fn(), publish: vi.fn(), ...overrides,
});

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

  // `publish` throws this before `repository.publish` ever runs (the servability recheck), or from
  // inside its own transaction - both prove the publication never wrote, so the receipt can settle
  // durably instead of leaving the operator retrying an owner refusal that will never change.
  it("settles a servability refusal as a durable failed publication, not an uncertain MCP apply", async () => {
    const publish = vi.fn().mockRejectedValue(new AppError(422, "revision_invalid", "The draft contains a routine that cannot be released."));
    const adapter = createAgentPublicationProposalAdapter({ revisions: revisionPort({ state: vi.fn().mockResolvedValue(state), publish }) });
    await expect(adapter.applyIfVersionMatches("workspace-1", target, payload, `4:${payload.expectedPublishedRevisionId}`, context))
      .resolves.toEqual({ outcome: "failed", reason: "The draft contains a routine that cannot be released." });
  });

  it("keeps an unclassifiable publish failure uncertain by rethrowing it on an MCP apply", async () => {
    const publish = vi.fn().mockRejectedValue(new Error("connection reset"));
    const adapter = createAgentPublicationProposalAdapter({ revisions: revisionPort({ state: vi.fn().mockResolvedValue(state), publish }) });
    await expect(adapter.applyIfVersionMatches("workspace-1", target, payload, `4:${payload.expectedPublishedRevisionId}`, context)).rejects.toThrow("connection reset");
  });

  // Unlike the routine/skill atomic ports, publish is not fenced by this proposal's apply claim -
  // only by draft generation and the idempotency key - so an earlier attempt that already passed
  // the servability recheck can still commit after this reclaim observes the refusal below. A
  // refusal on reconcile therefore cannot prove not_applied; it must rethrow to uncertain.
  it("rethrows a servability refusal on reconcile instead of certifying an unproven not applied", async () => {
    const publish = vi.fn().mockRejectedValue(new AppError(422, "revision_invalid", "The draft contains a routine that cannot be released."));
    const adapter = createAgentPublicationProposalAdapter({ revisions: revisionPort({ publish }) });
    await expect(adapter.reconcileMcpInterruptedApply?.({ workspaceId: "workspace-1", accountId: "account-1", targetRef: target, payload, versionToken: `4:${payload.expectedPublishedRevisionId}`, executionInvocationId: "execution-1", previousAttemptStartedAt: new Date() }))
      .rejects.toThrow("The draft contains a routine that cannot be released.");
  });

  it("rethrows an unclassifiable reconcile failure instead of reporting an unproven unknown effect", async () => {
    const publish = vi.fn().mockRejectedValue(new Error("connection reset"));
    const adapter = createAgentPublicationProposalAdapter({ revisions: revisionPort({ publish }) });
    await expect(adapter.reconcileMcpInterruptedApply?.({ workspaceId: "workspace-1", accountId: "account-1", targetRef: target, payload, versionToken: `4:${payload.expectedPublishedRevisionId}`, executionInvocationId: "execution-1", previousAttemptStartedAt: new Date() }))
      .rejects.toThrow("connection reset");
  });
});
