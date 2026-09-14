import { describe, expect, it, vi } from "vitest";

import { createAgentPublicationCopilotTools } from "../../../src/modules/operatorCopilot/tools/agentPublication.js";
import { createReviewedProposalExecutionTool } from "../../../src/modules/operatorCopilot/tools/reviewedProposalExecution.js";

const context = { workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "operator-1", currentAuthorization: { hasAllPermissions: vi.fn(async () => true) }, copilotConversationId: undefined, operatorMcpInvocationId: "invocation-1", surface: "mcp" as const, pageContext: { view: "agent" as const, agentId: "agent-1", conversationId: null, selection: null, entities: [] } };

describe("agent publication MCP tools", () => {
  it("recovers the original publication review without creating another candidate", async () => {
    const createCandidate = vi.fn(); const createProposal = vi.fn();
    const snapshot = { candidateRevisionId: "11111111-1111-4111-8111-111111111111", draftGeneration: 4, publishedRevisionId: null, validation: { status: "valid" as const } };
    const tools = createAgentPublicationCopilotTools({ revisions: { state: vi.fn(), createCandidate, detail: vi.fn(), describeCandidateRelease: vi.fn(), readCandidateReleaseChange: vi.fn(), publish: vi.fn() }, proposalRepository: { createProposal }, proposalRecovery: { recoverOperatorMcpProposal: vi.fn(async () => ({ status: "recovered", proposal: { id: "proposal-1", targetType: "agent_publication", reviewDigest: "d".repeat(43), expiresAt: new Date("2026-09-13T00:15:00Z"), reviewSnapshot: snapshot } })) }, proposalAdapters: [], auditService: { record: vi.fn() } });
    const prepare = tools.find((tool) => tool.name === "prepare_agent_publication")!;
    await expect(prepare.reconcileMcpInvocation!({ invocation: { id: "invocation-1", grantId: "grant-1", operationId: "op-1", inputDigest: "digest" }, context, staleBefore: new Date(0), now: new Date() } as never)).resolves.toMatchObject({ status: "recovered", output: { proposalId: "proposal-1", reviewDigest: "d".repeat(43), ...snapshot } });
    expect(createCandidate).not.toHaveBeenCalled(); expect(createProposal).not.toHaveBeenCalled();
  });
  it("reads publication state and persists a bounded reviewed candidate proposal", async () => {
    const state = vi.fn().mockResolvedValue({ draft: { generation: 4, basePublishedRevisionId: "published-3" } });
    const createCandidate = vi.fn().mockResolvedValue({ id: "candidate-1" });
    const createProposal = vi.fn().mockResolvedValue({ id: "proposal-1" });
    const readCandidateReleaseChange = vi.fn().mockResolvedValue({ text: "b".repeat(200), nextOffset: 200, totalLength: 300 });
    const tools = createAgentPublicationCopilotTools({ revisions: { state, createCandidate, detail: vi.fn(), describeCandidateRelease: vi.fn(), readCandidateReleaseChange, publish: vi.fn() }, proposalRepository: { createProposal }, proposalRecovery: { recoverOperatorMcpProposal: vi.fn() }, proposalAdapters: [], auditService: { record: vi.fn() }, now: () => new Date("2026-09-13T00:00:00Z") });
    const read = tools.find((tool) => tool.name === "agent_publication_state")!;
    const prepare = tools.find((tool) => tool.name === "prepare_agent_publication")!;
    await expect(read.createTool(context).invoke({}, {} as never)).resolves.toMatchObject({ draftGeneration: 4, publishedRevisionId: null });
    const output = await prepare.createTool(context).invoke({}, {} as never) as { reviewDigest: string; expiresAt: string };
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({ targetType: "agent_publication", targetRef: { agentId: "agent-1", candidateRevisionId: "candidate-1" }, payload: { expectedDraftGeneration: 4, expectedPublishedRevisionId: "published-3" }, reviewDigest: expect.any(String), expiresAt: expect.any(Date), origin: { type: "operator_mcp_invocation", invocationId: "invocation-1" } }));
    expect(output.reviewDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createReviewedProposalExecutionTool({ executeMcpReviewedProposal: vi.fn() }).inputSchema.safeParse({ proposalId: "11111111-1111-4111-8111-111111111111", reviewDigest: output.reviewDigest }).success).toBe(true);
    expect(output.expiresAt).toBe("2026-09-13T00:15:00.000Z");
    const detail = tools.find((tool) => tool.name === "agent_publication_candidate_change")!;
    await expect(detail.createTool(context).invoke({ agentId: "agent-1", candidateRevisionId: "candidate-1", field: "customInstruction", id: "agent", side: "after", offset: 0, limit: 200 }, {} as never)).resolves.toEqual({ text: "b".repeat(200), nextOffset: 200, totalLength: 300 });
  });
  it("does not create a candidate or proposal when permission is revoked while reading state", async () => {
    const authorization = { hasAllPermissions: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) };
    const createCandidate = vi.fn(); const createProposal = vi.fn();
    const tools = createAgentPublicationCopilotTools({ revisions: { state: vi.fn(async () => ({ draft: { generation: 1, basePublishedRevisionId: null } })), createCandidate, detail: vi.fn(), describeCandidateRelease: vi.fn(), readCandidateReleaseChange: vi.fn(), publish: vi.fn() }, proposalRepository: { createProposal }, proposalRecovery: { recoverOperatorMcpProposal: vi.fn() }, proposalAdapters: [], auditService: { record: vi.fn() } });
    const prepare = tools.find((tool) => tool.name === "prepare_agent_publication")!;
    await expect(prepare.createTool({ ...context, currentAuthorization: authorization }).invoke({}, {} as never)).rejects.toThrow();
    expect(createCandidate).not.toHaveBeenCalled(); expect(createProposal).not.toHaveBeenCalled();
  });

  it("does not persist a proposal when permission is revoked after candidate creation", async () => {
    const authorization = { hasAllPermissions: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false) };
    const createCandidate = vi.fn(async () => ({ id: "candidate-1" })); const createProposal = vi.fn();
    const tools = createAgentPublicationCopilotTools({ revisions: { state: vi.fn(async () => ({ draft: { generation: 1, basePublishedRevisionId: null } })), createCandidate, detail: vi.fn(), describeCandidateRelease: vi.fn(), readCandidateReleaseChange: vi.fn(), publish: vi.fn() }, proposalRepository: { createProposal }, proposalRecovery: { recoverOperatorMcpProposal: vi.fn() }, proposalAdapters: [], auditService: { record: vi.fn() } });
    const prepare = tools.find((tool) => tool.name === "prepare_agent_publication")!;
    await expect(prepare.createTool({ ...context, currentAuthorization: authorization }).invoke({}, {} as never)).rejects.toThrow();
    expect(createCandidate).toHaveBeenCalledOnce(); expect(createProposal).not.toHaveBeenCalled();
  });
});
