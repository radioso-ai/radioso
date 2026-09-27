import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import type { DirectiveCoherenceVerdict } from "@radioso/conversation-defaults";

import {
  OperatorCopilotService,
  CopilotAuthorizationError,
  type CopilotConversation,
  type CopilotMessage,
  type CopilotProposal,
  type CopilotProposalApplyClaimGuard,
  type CopilotProposalClaim,
  type CopilotProposalDraft,
  type CopilotRepositoryPort,
  type CopilotSurface,
  type CopilotToolDescriptor,
} from "../../../src/modules/operatorCopilot/public.js";
import { AuthoredDirectiveService, DirectiveAuthorService, type AuthoredDirective, type AuthoredDirectiveInput } from "../../../src/modules/agents/public.js";
import { createDirectiveCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/proposalAdapters.js";
import { createDirectiveReviewedPreparationTool } from "../../../src/modules/operatorCopilot/tools/directiveReviewedPreparation.js";
import { createReviewedProposalExecutionTool } from "../../../src/modules/operatorCopilot/tools/reviewedProposalExecution.js";
import { OperatorMcpCatalogService } from "../../../src/modules/operatorCopilot/mcpCatalog.js";
import { operatorMcpDispositions } from "../../../src/modules/operatorCopilot/operatorMcpDisposition.js";
import type { CopilotReviewedReceiptPort } from "../../../src/modules/operatorCopilot/contracts.js";
import { AppError, conflict, notFound } from "../../../src/shared/domain/errors.js";

const workspaceId = randomUUID();
const accountId = randomUUID();
const operatorUserId = randomUUID();
const grantId = randomUUID();
const clientId = randomUUID();
const pageContext = { view: "other" as const, agentId: null, conversationId: null, selection: null, entities: [] };

/** A placeholder for the Kysely transaction handle: never inspected by these fakes. */
const FAKE_TRX = {} as never;

type FakeDirective = AuthoredDirective;

const toDirectiveRecord = (agentId: string, input: Record<string, unknown>, now: Date, id: string = randomUUID(), createdAt: Date = now): FakeDirective => ({
  id,
  agentId,
  name: input.name as string,
  condition: input.condition as FakeDirective["condition"],
  action: input.action as string,
  priority: (input.priority as number | null | undefined) ?? null,
  requiredCapabilities: (input.requiredCapabilities as string[] | undefined) ?? [],
  dependsOn: (input.dependsOn as string[] | undefined) ?? [],
  excludes: (input.excludes as string[] | undefined) ?? [],
  routes: [],
  tags: (input.tags as string[] | undefined) ?? [],
  surfaces: (input.surfaces as FakeDirective["surfaces"] | undefined) ?? [],
  description: (input.description as string | null | undefined) ?? null,
  binding: (input.binding as FakeDirective["binding"]) ?? null,
  lifecycle: (input.lifecycle as FakeDirective["lifecycle"]) ?? null,
  enabled: (input.enabled as boolean | undefined) ?? true,
  metadata: (input.metadata as Record<string, unknown> | undefined) ?? {},
  createdAt,
  updatedAt: now,
});

type CommitHook = ((trx: unknown, committed: unknown) => Promise<void>) | undefined;

/**
 * Mirrors the real AgentRepository's directive persistence closely enough to exercise the reviewed
 * seam end to end: every directive write bumps the agent row (the create fence), a name collision
 * on the (agent_id, name) constraint throws with the same distinguishing detail the real repository
 * attaches, and an `onCommitted` hook runs only after the write is computed and rolls the write back
 * if it throws — matching "throw only before commit" from the owner commit-hook contract.
 */
class FakeDirectiveRepository {
  agent: { id: string; name: string; customInstruction: string; greetingInstruction: string; assistantDefaultLocale: string | null; chatModelOverride: null; updatedAt: Date };
  directives: FakeDirective[] = [];
  createCalls = 0;
  updateCalls = 0;
  deleteCalls = 0;
  /**
   * A monotonic clock, one tick per write. Two writes in the same test can otherwise land in the
   * same wall-clock millisecond, which would make a genuine CAS mismatch invisible to a test that
   * checks it by real elapsed time.
   */
  private clockMs: number;

  constructor(agentId: string, now: Date) {
    this.clockMs = now.getTime();
    // The coherence checker builds its `instructions` array from these with a bare `.trim()`;
    // a null here throws inside `checkCoherence`'s try/catch and silently falls back to
    // "unavailable" without ever calling the checker, which would mask what these tests assert.
    this.agent = { id: agentId, name: "Test agent", customInstruction: "", greetingInstruction: "", assistantDefaultLocale: null, chatModelOverride: null, updatedAt: now };
  }

  private tick(): Date {
    this.clockMs += 1_000;
    return new Date(this.clockMs);
  }

  async findByIdAndWorkspaceId() {
    return this.agent;
  }

  async listDirectives(): Promise<FakeDirective[]> {
    return this.directives;
  }

  async createDirective(_agentId: string, _workspaceId: string, input: AuthoredDirectiveInput, options: { expectedAgentUpdatedAt?: Date; onCommitted?: CommitHook } = {}): Promise<FakeDirective> {
    if (options.expectedAgentUpdatedAt && options.expectedAgentUpdatedAt.getTime() !== this.agent.updatedAt.getTime()) {
      throw conflict("Agent was updated by another writer; reload before saving again");
    }
    if (this.directives.some((directive) => directive.name === input.name)) {
      throw new AppError(409, "conflict", `A directive named "${input.name}" already exists for this agent.`, { reason: "duplicate_name" });
    }
    const now = this.tick();
    const directive = toDirectiveRecord(this.agent.id, input, now);
    if (options.onCommitted) await options.onCommitted(FAKE_TRX, directive);
    this.directives.push(directive);
    this.agent = { ...this.agent, updatedAt: now };
    this.createCalls += 1;
    return directive;
  }

  async updateDirective(_agentId: string, _workspaceId: string, directiveId: string, input: Partial<AuthoredDirectiveInput>, options: { expectedUpdatedAt?: Date; onCommitted?: CommitHook } = {}): Promise<FakeDirective> {
    const existing = this.directives.find((directive) => directive.id === directiveId);
    if (!existing) throw notFound("Directive not found");
    if (options.expectedUpdatedAt && existing.updatedAt.getTime() !== options.expectedUpdatedAt.getTime()) {
      throw conflict("Directive was updated by another writer; reload before saving again");
    }
    const nextName = (input as Record<string, unknown>).name as string | undefined;
    if (nextName && this.directives.some((directive) => directive.id !== directiveId && directive.name === nextName)) {
      throw new AppError(409, "conflict", `A directive named "${nextName}" already exists for this agent.`, { reason: "duplicate_name" });
    }
    const now = this.tick();
    const merged = toDirectiveRecord(this.agent.id, input, now, existing.id, existing.createdAt);
    if (options.onCommitted) await options.onCommitted(FAKE_TRX, merged);
    this.directives = this.directives.map((directive) => (directive.id === directiveId ? merged : directive));
    this.agent = { ...this.agent, updatedAt: now };
    this.updateCalls += 1;
    return merged;
  }

  async deleteDirective(_agentId: string, _workspaceId: string, directiveId: string, options: { expectedUpdatedAt?: Date; onCommitted?: CommitHook } = {}): Promise<boolean> {
    const existing = this.directives.find((directive) => directive.id === directiveId);
    if (!existing) return false;
    if (options.expectedUpdatedAt && existing.updatedAt.getTime() !== options.expectedUpdatedAt.getTime()) return false;
    if (options.onCommitted) await options.onCommitted(FAKE_TRX, { directiveId });
    this.directives = this.directives.filter((directive) => directive.id !== directiveId);
    this.agent = { ...this.agent, updatedAt: this.tick() };
    this.deleteCalls += 1;
    return true;
  }
}

/** A trimmed CopilotRepositoryPort fake: proposal storage, claims, and receipt settlement in memory. */
class MemoryProposalRepository implements CopilotRepositoryPort {
  conversations: CopilotConversation[] = [];
  messages: CopilotMessage[] = [];
  proposals: CopilotProposal[] = [];
  private readonly applyClaims = new Map<string, Date>();
  private readonly mcpPreparations = new Map<string, { grantId: string; clientId: string }>();

  async createConversation(input: { workspaceId: string; operatorUserId: string; title: string | null }): Promise<CopilotConversation> {
    const createdAt = new Date();
    const conversation = { id: randomUUID(), ...input, status: "idle" as const, createdAt, updatedAt: createdAt };
    this.conversations.push(conversation);
    return conversation;
  }
  async findConversation(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotConversation | null> {
    return this.conversations.find((item) => item.id === input.id && item.workspaceId === input.workspaceId && item.operatorUserId === input.operatorUserId) ?? null;
  }
  async listConversations(input: { workspaceId: string; operatorUserId: string }): Promise<ReadonlyArray<CopilotConversation>> {
    return this.conversations.filter((item) => item.workspaceId === input.workspaceId && item.operatorUserId === input.operatorUserId);
  }
  async deleteConversation(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<boolean> {
    const found = await this.findConversation(input);
    if (!found) return false;
    this.conversations = this.conversations.filter((item) => item.id !== found.id);
    return true;
  }
  async createMessage(input: Omit<CopilotMessage, "id" | "createdAt">): Promise<CopilotMessage> {
    const message = { ...input, id: randomUUID(), createdAt: new Date() };
    this.messages.push(message);
    return message;
  }
  async listMessages(input: { conversationId: string }): Promise<ReadonlyArray<CopilotMessage>> {
    return this.messages.filter((item) => item.conversationId === input.conversationId);
  }
  async acquireTurn(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotConversation | "running" | null> {
    const conversation = await this.findConversation(input);
    if (!conversation || conversation.status === "running") return conversation ? "running" : null;
    const next = { ...conversation, status: "running" as const };
    this.conversations[this.conversations.indexOf(conversation)] = next;
    return next;
  }
  async finishTurn(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<void> {
    const conversation = await this.findConversation(input);
    if (conversation) this.conversations[this.conversations.indexOf(conversation)] = { ...conversation, status: "idle" };
  }
  async createProposal(input: CopilotProposalDraft): Promise<CopilotProposal> {
    const createdAt = new Date();
    const origin = input.origin ?? { type: "conversation" as const, conversationId: input.conversationId };
    if (origin.type === "operator_mcp_invocation") this.mcpPreparations.set(origin.invocationId, { grantId, clientId });
    const proposal: CopilotProposal = {
      ...input, origin,
      conversationId: origin.type === "conversation" ? origin.conversationId : null,
      operatorMcpInvocationId: origin.type === "operator_mcp_invocation" ? origin.invocationId : null,
      id: randomUUID(), messageId: null,
      reviewDigest: input.reviewDigest ?? null, reviewSnapshot: input.reviewSnapshot ?? null, expiresAt: input.expiresAt ?? null,
      executionInvocationId: null, status: "pending", reason: null, appliedRef: null, createdAt, updatedAt: createdAt,
    };
    this.proposals.push(proposal);
    return proposal;
  }
  async findProposal(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotProposal | null> {
    return this.proposals.find((item) => item.id === input.id && item.workspaceId === input.workspaceId && item.operatorUserId === input.operatorUserId) ?? null;
  }
  async findMcpReviewedProposal(input: { id: string; workspaceId: string; operatorUserId: string; grantId: string; clientId: string }): Promise<CopilotProposal | null> {
    const proposal = await this.findProposal(input);
    const binding = proposal?.operatorMcpInvocationId ? this.mcpPreparations.get(proposal.operatorMcpInvocationId) : undefined;
    return proposal?.reviewDigest && binding?.grantId === input.grantId && binding.clientId === input.clientId ? proposal : null;
  }
  async findProposalWorkspace(input: { id: string; accountId: string; operatorUserId: string }): Promise<string | null> {
    return this.proposals.find((item) => item.id === input.id && item.operatorUserId === input.operatorUserId)?.workspaceId ?? null;
  }
  async attachProposalsToMessage(): Promise<void> {}
  async updateProposalOutcome(input: { id: string; workspaceId: string; operatorUserId: string; status: CopilotProposal["status"]; appliedRef?: unknown; reason?: string | null; applyClaimGuard: CopilotProposalApplyClaimGuard }): Promise<CopilotProposal | null> {
    const proposal = await this.findProposal(input);
    if (!proposal || proposal.status !== "pending") return null;
    if (!this.satisfiesClaimGuard(proposal.id, input.applyClaimGuard)) return null;
    const next = { ...proposal, status: input.status, reason: input.reason ?? null, appliedRef: input.appliedRef ?? null, updatedAt: new Date() };
    this.proposals[this.proposals.indexOf(proposal)] = next;
    this.applyClaims.delete(proposal.id);
    return next;
  }
  async cancelPendingProposal(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotProposal | null> {
    const proposal = await this.findProposal(input);
    if (!proposal || proposal.status !== "pending" || proposal.executionInvocationId !== null || this.applyClaims.has(proposal.id)) return null;
    const dismissed = { ...proposal, status: "dismissed" as const, updatedAt: new Date() };
    this.proposals[this.proposals.indexOf(proposal)] = dismissed;
    return dismissed;
  }
  async claimProposalApply(input: { id: string; workspaceId: string; operatorUserId: string; claimTtlSeconds: number }): Promise<CopilotProposalClaim | null> {
    const proposal = await this.findProposal(input);
    if (!proposal || proposal.status !== "pending") return null;
    if (!this.isClaimFree(proposal.id, input.claimTtlSeconds)) return null;
    const claimedAt = new Date();
    const previousAttemptStartedAt = this.applyClaims.get(proposal.id) ?? null;
    this.applyClaims.set(proposal.id, claimedAt);
    return { proposal, claimedAt, previousAttemptStartedAt };
  }
  async releaseProposalApplyClaim(input: { id: string; workspaceId: string; operatorUserId: string; claimedAt: Date }): Promise<boolean> {
    const proposal = await this.findProposal(input);
    if (!proposal || proposal.status !== "pending") return false;
    const claimedAt = this.applyClaims.get(proposal.id);
    if (!claimedAt || claimedAt.getTime() !== input.claimedAt.getTime()) return false;
    this.applyClaims.delete(proposal.id);
    return true;
  }
  async claimMcpReviewedProposalApply(input: { proposalId: string; executionInvocationId: string; reviewDigest: string; workspaceId: string; operatorUserId: string; grantId: string; clientId: string; now: Date; claimTtlSeconds: number }): ReturnType<CopilotRepositoryPort["claimMcpReviewedProposalApply"]> {
    const proposal = await this.findMcpReviewedProposal({ id: input.proposalId, workspaceId: input.workspaceId, operatorUserId: input.operatorUserId, grantId: input.grantId, clientId: input.clientId });
    if (!proposal) return { status: "missing" };
    if (proposal.reviewDigest !== input.reviewDigest) return { status: "digest_mismatch" };
    if (proposal.status === "dismissed") return { status: "canceled" };
    if (proposal.status !== "pending") {
      return { status: "settled", outcome: proposal.status, appliedRef: proposal.appliedRef, ...(proposal.reason ? { reason: proposal.reason } : {}) };
    }
    if (proposal.expiresAt && proposal.expiresAt.getTime() < input.now.getTime()) return { status: "expired" };
    if (proposal.executionInvocationId && proposal.executionInvocationId !== input.executionInvocationId) {
      return this.isClaimFree(proposal.id, input.claimTtlSeconds) ? { status: "binding_mismatch" } : { status: "claim_held" };
    }
    const claim = await this.claimProposalApply({ id: input.proposalId, workspaceId: input.workspaceId, operatorUserId: input.operatorUserId, claimTtlSeconds: input.claimTtlSeconds });
    if (!claim) return { status: "claim_held" };
    this.proposals[this.proposals.findIndex((item) => item.id === proposal.id)] = { ...proposal, executionInvocationId: input.executionInvocationId };
    return { status: "claimed", claim };
  }
  /** Mirrors CopilotRepository.settleMcpAppliedOn's claim guard: only the still-held exact claim may settle. */
  settleMcpAppliedOnSync(input: { proposalId: string; executionInvocationId: string; workspaceId: string; operatorUserId: string; claimedAt: Date; appliedRef: unknown }): boolean {
    const proposal = this.proposals.find((item) => item.id === input.proposalId && item.workspaceId === input.workspaceId && item.operatorUserId === input.operatorUserId && item.status === "pending" && item.executionInvocationId === input.executionInvocationId);
    if (!proposal) return false;
    const claimedAt = this.applyClaims.get(proposal.id);
    if (!claimedAt || claimedAt.getTime() !== input.claimedAt.getTime()) return false;
    this.proposals[this.proposals.indexOf(proposal)] = { ...proposal, status: "applied", appliedRef: input.appliedRef, updatedAt: new Date() };
    this.applyClaims.delete(proposal.id);
    return true;
  }
  hasApplyClaim(id: string): boolean { return this.applyClaims.has(id); }
  expireApplyClaim(id: string): void { this.applyClaims.set(id, new Date(Date.now() - 301_000)); }
  private isClaimFree(proposalId: string, claimTtlSeconds: number): boolean {
    const claimedAt = this.applyClaims.get(proposalId);
    return !claimedAt || Date.now() - claimedAt.getTime() >= claimTtlSeconds * 1000;
  }
  private satisfiesClaimGuard(proposalId: string, guard: CopilotProposalApplyClaimGuard): boolean {
    if (guard.state === "free") return this.isClaimFree(proposalId, guard.claimTtlSeconds);
    const claimedAt = this.applyClaims.get(proposalId);
    return claimedAt !== undefined && claimedAt.getTime() === guard.claimedAt.getTime();
  }
}

const buildFixture = () => {
  const agentId = randomUUID();
  const now = new Date("2026-09-26T10:00:00.000Z");
  const directiveRepository = new FakeDirectiveRepository(agentId, now);
  const checker = { check: vi.fn(async (): Promise<DirectiveCoherenceVerdict> => ({ coherent: true, conflicts: [], rationale: "Coherent." })) };
  const textGenerationClient = { complete: vi.fn(async () => { throw new Error("the coach must not run for a verbatim structured directive request"); }) };
  const authoredDirectiveService = new AuthoredDirectiveService({ repository: directiveRepository, coherenceChecker: checker, registeredCapabilityNames: new Set() });
  const directiveAuthorService = new DirectiveAuthorService({
    // DirectiveAuthorServiceOptions.repository types findByIdAndWorkspaceId against the full
    // ConversationAgent record; the service only ever reads the handful of fields this fake
    // models, matching AuthoredDirectiveService's own narrower repository contract above.
    repository: directiveRepository as never, textGenerationClient, logger: { info: vi.fn(), warn: vi.fn() }, buildStepScopeTag: (routineId: string, stepId: string) => `step:${routineId}:${stepId}`,
  });
  const proposalRepository = new MemoryProposalRepository();
  const reviewedReceipt: CopilotReviewedReceiptPort = {
    commitHook: ({ proposalId, executionInvocationId, workspaceId, operatorUserId, claimedAt, toAppliedRef }) =>
      async (_trx, committed) => {
        const settled = proposalRepository.settleMcpAppliedOnSync({ proposalId, executionInvocationId, workspaceId, operatorUserId, claimedAt, appliedRef: toAppliedRef(committed) });
        if (!settled) throw new Error("reviewed_proposal_receipt_conflict");
      },
  };
  const adapter = createDirectiveCopilotProposalAdapter({
    authoredDirectiveService, directiveAuthorService,
    agentService: { get: vi.fn(async () => ({ updatedAt: directiveRepository.agent.updatedAt })) } as never,
    reviewedReceipt,
  });
  const currentAuthorization = {
    hasAllPermissions: vi.fn(async (_input: { workspaceId: string; accountId: string; operatorUserId: string; requiredPermissions: readonly string[] }) => true),
  };
  const context = {
    workspaceId, accountId, operatorUserId, surface: "mcp" as const,
    operatorMcpInvocationId: randomUUID(), operatorMcpGrantId: grantId, operatorMcpClientId: clientId,
    currentAuthorization, pageContext,
  };
  const prepareDescriptor = createDirectiveReviewedPreparationTool({
    proposalRepository, proposalAdapters: [], proposalRecovery: { recoverOperatorMcpProposal: vi.fn() }, auditService: { record: vi.fn() }, now: () => new Date(),
    directiveAuthor: directiveAuthorService, directives: authoredDirectiveService,
  });
  const service = new OperatorCopilotService({
    repository: proposalRepository, capabilityRunner: { runStreaming: vi.fn() }, usageLimitPolicy: {
      reserveAnswer: vi.fn(), reserveDocument: vi.fn(), reserveIndexedStorage: vi.fn(), reserveMonthlyIndexedContent: vi.fn(),
    }, auditService: { record: vi.fn() }, prompt: "system", workspaceRouteKeyResolver: { resolveWorkspaceKey: async () => "workspace" },
    currentAuthorization, tools: [], proposalAdapters: [adapter],
  });
  const executeDescriptor = createReviewedProposalExecutionTool({ executeMcpReviewedProposal: service.executeMcpReviewedProposal.bind(service) });
  const catalog = new OperatorMcpCatalogService([prepareDescriptor, executeDescriptor].map((descriptor) => ({ ...descriptor, mcpDisposition: operatorMcpDispositions[descriptor.name] })));
  const invoke = (name: string, args: unknown) => catalog.invoke({ name, arguments: args, context, scopes: new Set(["operator:propose", "operator:write"]), signal: AbortSignal.timeout(2_000) });
  return { agentId, directiveRepository, checker, textGenerationClient, proposalRepository, service, adapter, currentAuthorization, invoke, context };
};

type PrepareInput = { kind: "create" | "edit" | "set_enabled" | "remove"; agentId: string; directiveId?: string; [key: string]: unknown };

const seedExisting = async (fixture: ReturnType<typeof buildFixture>, name = "quote-primary") => {
  const { directive } = await new AuthoredDirectiveService({ repository: fixture.directiveRepository, coherenceChecker: fixture.checker, registeredCapabilityNames: new Set() })
    .create(workspaceId, fixture.agentId, { name, condition: { kind: "always" }, action: "Quote the source verbatim." }, { coherence: "skip" });
  return directive;
};

describe("reviewed directives, prepared and executed through the operator MCP catalog", () => {
  it("reports a partial structured edit as verbatim without calling the coach", async () => {
    const fixture = buildFixture();
    const existing = await seedExisting(fixture);

    const prepared = await fixture.invoke("prepare_directive", {
      kind: "edit", agentId: fixture.agentId, directiveId: existing.id, priority: 90,
    }) as { review: { drafting: string } };

    expect(prepared.review.drafting).toBe("verbatim");
    expect(fixture.textGenerationClient.complete).not.toHaveBeenCalled();
  });

  it("returns the owner's typed unavailable coherence status", async () => {
    const fixture = buildFixture();
    fixture.checker.check.mockRejectedValueOnce(new Error("provider unavailable"));

    const prepared = await fixture.invoke("prepare_directive", {
      kind: "create", agentId: fixture.agentId, name: "coherence-unavailable", condition: { kind: "always" }, action: "Keep the requested answer concise.",
    }) as { review: { coherence: { status: string } } };

    expect(prepared.review.coherence.status).toBe("unavailable");
  });

  it("bounds oversized coherence text before persisting a readable review", async () => {
    const fixture = buildFixture();
    fixture.checker.check.mockResolvedValueOnce({
      coherent: false,
      conflicts: [{ directiveName: "n".repeat(201), reason: "r".repeat(1_001) }],
      rationale: "a".repeat(2_001),
    });

    const prepared = await fixture.invoke("prepare_directive", {
      kind: "create", agentId: fixture.agentId, name: "long-coherence", condition: { kind: "always" }, action: "Use the supplied instruction.",
    }) as { proposalId: string; review: { coherence: { conflicts: Array<{ directiveName: string; reason: string }>; rationale: string } } };

    expect(prepared.review.coherence.conflicts[0]).toMatchObject({ directiveName: "n".repeat(200), reason: "r".repeat(1_000) });
    expect(prepared.review.coherence.rationale).toBe("a".repeat(2_000));
    expect(fixture.proposalRepository.proposals.find((proposal) => proposal.id === prepared.proposalId)?.reviewSnapshot)
      .toMatchObject({ coherence: prepared.review.coherence });
  });

  it("bounds removal references before persisting its readable review", async () => {
    const fixture = buildFixture();
    const target = await seedExisting(fixture, "target-directive");
    fixture.directiveRepository.directives.push(...Array.from({ length: 101 }, (_, index) => toDirectiveRecord(
      fixture.agentId,
      { name: `referrer-${index}`, condition: { kind: "always" }, action: "Keep this reference.", excludes: [target.name] },
      new Date(`2026-09-26T10:${String(index % 60).padStart(2, "0")}:00.000Z`),
    )));

    const prepared = await fixture.invoke("prepare_directive", {
      kind: "remove", agentId: fixture.agentId, directiveId: target.id,
    }) as { proposalId: string; review: { referencedBy: unknown[]; referencedByTruncated: boolean } };

    expect(prepared.review.referencedBy).toHaveLength(100);
    expect(prepared.review.referencedByTruncated).toBe(true);
    expect(fixture.proposalRepository.proposals.find((proposal) => proposal.id === prepared.proposalId)?.reviewSnapshot)
      .toMatchObject({ referencedBy: expect.any(Array), referencedByTruncated: true });
  });

  it.each([
    { kind: "create" as const },
    { kind: "edit" as const },
    { kind: "set_enabled" as const },
    { kind: "remove" as const },
  ])("prepares a $kind review and applies it with the exact appliedRef, verbatim, with no coach or coherence call at execute", async ({ kind }) => {
    const fixture = buildFixture();
    const existing = kind === "create" ? null : await seedExisting(fixture);
    const input: PrepareInput = kind === "create"
      ? { kind, agentId: fixture.agentId, name: "quote-primary", condition: { kind: "always" }, action: "Quote the source verbatim.", priority: 42, excludes: [] }
      : kind === "edit"
        ? { kind, agentId: fixture.agentId, directiveId: existing!.id, name: "quote-primary", condition: { kind: "always" }, action: "Quote the source verbatim, with attribution.", priority: 42, excludes: [] }
        : kind === "set_enabled"
          ? { kind, agentId: fixture.agentId, directiveId: existing!.id, enabled: false }
          : { kind, agentId: fixture.agentId, directiveId: existing!.id };

    const prepared = await fixture.invoke("prepare_directive", input) as { proposalId: string; reviewDigest: string; review: { kind: string; irreversible: boolean } };
    expect(prepared.review.kind).toBe(kind);
    expect(prepared.review.irreversible).toBe(kind === "remove");
    // Coherence runs at prepare for an enabled create/edit; disable and remove never need it.
    expect(fixture.checker.check).toHaveBeenCalledTimes(kind === "create" || kind === "edit" ? 1 : 0);
    expect(fixture.textGenerationClient.complete).not.toHaveBeenCalled();
    const coherenceCallsAtPrepare = fixture.checker.check.mock.calls.length;

    const executed = await fixture.invoke("execute_reviewed_proposal", { proposalId: prepared.proposalId, reviewDigest: prepared.reviewDigest }) as { status: string; appliedRef: unknown };

    expect(executed.status).toBe("applied");
    if (kind === "create") {
      expect(executed.appliedRef).toMatchObject({ directiveId: expect.any(String) });
      const created = fixture.directiveRepository.directives.find((directive) => directive.name === "quote-primary");
      expect(created).toMatchObject({ action: "Quote the source verbatim.", priority: 42 });
    } else {
      expect(executed.appliedRef).toEqual({ directiveId: existing!.id });
    }
    if (kind === "edit") {
      const updated = fixture.directiveRepository.directives.find((directive) => directive.id === existing!.id);
      expect(updated).toMatchObject({ action: "Quote the source verbatim, with attribution.", priority: 42 });
    }
    if (kind === "set_enabled") {
      expect(fixture.directiveRepository.directives.find((directive) => directive.id === existing!.id)?.enabled).toBe(false);
    }
    if (kind === "remove") {
      expect(fixture.directiveRepository.directives.find((directive) => directive.id === existing!.id)).toBeUndefined();
    }
    // Execute must not repeat the coach or the advisory coherence check: the stored payload
    // executes verbatim with `coherence: "skip"`.
    expect(fixture.checker.check).toHaveBeenCalledTimes(coherenceCallsAtPrepare);
    expect(fixture.textGenerationClient.complete).not.toHaveBeenCalled();
  });

  it("refuses an unknown excludes name at prepare as a caller-correctable refusal, not an outage", async () => {
    const fixture = buildFixture();

    const rejection = await fixture.invoke("prepare_directive", {
      kind: "create", agentId: fixture.agentId, name: "quote-primary", condition: { kind: "always" }, action: "Quote it.", excludes: ["not-a-real-directive"],
    }).then(() => null, (error: unknown) => error);

    expect(rejection).toBeInstanceOf(AppError);
    expect((rejection as AppError).statusCode).toBe(400);
    expect(fixture.proposalRepository.proposals).toHaveLength(0);
  });

  it("reports a create's name collision at execute as failed, not stale", async () => {
    const fixture = buildFixture();
    const firstPrepare = await fixture.invoke("prepare_directive", {
      kind: "create", agentId: fixture.agentId, name: "dup-name", condition: { kind: "always" }, action: "First.",
    }) as { proposalId: string; reviewDigest: string };
    await fixture.invoke("execute_reviewed_proposal", { proposalId: firstPrepare.proposalId, reviewDigest: firstPrepare.reviewDigest });

    // A create's fence is the agent-exists constant regardless of when it was prepared, so only
    // the (agent_id, name) collision - not a stale fence - can refuse this second create.
    const secondPrepare = await fixture.invoke("prepare_directive", {
      kind: "create", agentId: fixture.agentId, name: "dup-name", condition: { kind: "always" }, action: "Second.",
    }) as { proposalId: string; reviewDigest: string };
    const executed = await fixture.invoke("execute_reviewed_proposal", { proposalId: secondPrepare.proposalId, reviewDigest: secondPrepare.reviewDigest }) as { status: string; reason?: string };

    expect(executed.status).toBe("failed");
    expect(executed.reason).toContain("already exists");
    expect(fixture.directiveRepository.directives.filter((directive) => directive.name === "dup-name")).toHaveLength(1);
  });

  it("applies a create even after an unrelated write on the same agent lands before execute", async () => {
    const fixture = buildFixture();
    const prepared = await fixture.invoke("prepare_directive", {
      kind: "create", agentId: fixture.agentId, name: "survives-unrelated-write", condition: { kind: "always" }, action: "Should still apply.",
    }) as { proposalId: string; reviewDigest: string };

    // Bypasses the copilot layer entirely: an unrelated directive write on the same agent, which
    // bumps agents.updated_at. A create's fence is the agent-exists constant, not that row version,
    // so this must not invalidate the prepared create - the incident this behavior fixes was an
    // operator drafting a directive alongside agent-setting proposals where applying one first
    // used to invalidate the others.
    await new AuthoredDirectiveService({ repository: fixture.directiveRepository, coherenceChecker: fixture.checker, registeredCapabilityNames: new Set() })
      .create(workspaceId, fixture.agentId, { name: "unrelated", condition: { kind: "always" }, action: "Something else." }, { coherence: "skip" });

    const executed = await fixture.invoke("execute_reviewed_proposal", { proposalId: prepared.proposalId, reviewDigest: prepared.reviewDigest }) as { status: string; appliedRef: unknown };

    expect(executed.status).toBe("applied");
    expect(fixture.directiveRepository.directives.find((directive) => directive.name === "survives-unrelated-write")).toBeDefined();
  });

  it("reports an edit as stale once the same directive changes before execute", async () => {
    const fixture = buildFixture();
    const existing = await seedExisting(fixture, "edit-target");
    const prepared = await fixture.invoke("prepare_directive", {
      kind: "edit", agentId: fixture.agentId, directiveId: existing.id, name: "edit-target", condition: { kind: "always" }, action: "Should go stale.",
    }) as { proposalId: string; reviewDigest: string };

    await new AuthoredDirectiveService({ repository: fixture.directiveRepository, coherenceChecker: fixture.checker, registeredCapabilityNames: new Set() })
      .update(workspaceId, fixture.agentId, existing.id, { action: "Someone else edited this first." }, { coherence: "skip" });
    const writesBeforeExecute = fixture.directiveRepository.updateCalls + fixture.directiveRepository.deleteCalls;

    const executed = await fixture.invoke("execute_reviewed_proposal", { proposalId: prepared.proposalId, reviewDigest: prepared.reviewDigest }) as { status: string };

    expect(executed.status).toBe("stale");
    expect(fixture.directiveRepository.updateCalls + fixture.directiveRepository.deleteCalls).toBe(writesBeforeExecute);
    expect(fixture.directiveRepository.directives.find((directive) => directive.id === existing.id)?.action).toBe("Someone else edited this first.");
  });

  it.each([
    { kind: "set_enabled" as const, input: (directiveId: string) => ({ directiveId, enabled: false }) },
    { kind: "remove" as const, input: (directiveId: string) => ({ directiveId }) },
  ])("reports $kind as stale when the reviewed directive changes before execute", async ({ kind, input }) => {
    const fixture = buildFixture();
    const existing = await seedExisting(fixture, `${kind}-target`);
    const prepared = await fixture.invoke("prepare_directive", {
      kind, agentId: fixture.agentId, ...input(existing.id),
    }) as { proposalId: string; reviewDigest: string };

    await new AuthoredDirectiveService({ repository: fixture.directiveRepository, coherenceChecker: fixture.checker, registeredCapabilityNames: new Set() })
      .update(workspaceId, fixture.agentId, existing.id, { action: "Someone else edited this first." }, { coherence: "skip" });

    const executed = await fixture.invoke("execute_reviewed_proposal", { proposalId: prepared.proposalId, reviewDigest: prepared.reviewDigest }) as { status: string };

    expect(executed.status).toBe("stale");
    expect(fixture.directiveRepository.directives.find((directive) => directive.id === existing.id))
      .toMatchObject({ action: "Someone else edited this first.", enabled: true });
  });

  it("reconciles an interrupted claim to not_applied, then applies exactly once", async () => {
    const fixture = buildFixture();
    const prepared = await fixture.invoke("prepare_directive", {
      kind: "create", agentId: fixture.agentId, name: "recovered-create", condition: { kind: "always" }, action: "Recovered.",
    }) as { proposalId: string; reviewDigest: string };
    const reconcileSpy = vi.spyOn(fixture.adapter, "reconcileMcpInterruptedApply");
    const executionInvocationId = randomUUID();

    // Models a crashed first attempt: it claimed the receipt but never resolved it, and its lease
    // has since expired.
    const firstClaim = await fixture.proposalRepository.claimMcpReviewedProposalApply({
      proposalId: prepared.proposalId, executionInvocationId, reviewDigest: prepared.reviewDigest, workspaceId, operatorUserId, grantId, clientId, now: new Date(), claimTtlSeconds: 300,
    });
    if (firstClaim.status !== "claimed") throw new Error(`expected claim, got ${firstClaim.status}`);
    fixture.proposalRepository.expireApplyClaim(prepared.proposalId);

    // The same execution receipt retries directly through the service, exactly as the generic
    // execution tool would if a fresh MCP request reused this receipt's invocation id.
    const outcome = await fixture.service.executeMcpReviewedProposal({
      workspaceId, accountId, operatorUserId, proposalId: prepared.proposalId, reviewDigest: prepared.reviewDigest,
      executionInvocationId, grantId, clientId, currentAuthorization: fixture.currentAuthorization,
    });

    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("applied");
    expect(fixture.directiveRepository.directives.filter((directive) => directive.name === "recovered-create")).toHaveLength(1);
    expect(fixture.directiveRepository.createCalls).toBe(1);
  });

  it("refuses execute once the manage permission is revoked after prepare, without writing anything", async () => {
    const fixture = buildFixture();
    const prepared = await fixture.invoke("prepare_directive", {
      kind: "create", agentId: fixture.agentId, name: "revoked-permission", condition: { kind: "always" }, action: "Must not be written.",
    }) as { proposalId: string; reviewDigest: string };

    // `execute_reviewed_proposal` itself needs no catalog-level permission (it authorizes per
    // target, right before claiming), so only a check that actually names a required permission
    // — the directive owner's `workspace.agents.manage` — must start failing.
    fixture.currentAuthorization.hasAllPermissions.mockImplementation(
      async ({ requiredPermissions }: { requiredPermissions: readonly string[] }) => requiredPermissions.length === 0,
    );

    const rejection = await fixture.invoke("execute_reviewed_proposal", { proposalId: prepared.proposalId, reviewDigest: prepared.reviewDigest }).then(() => null, (error: unknown) => error);

    expect(rejection).toBeInstanceOf(CopilotAuthorizationError);
    expect(fixture.directiveRepository.directives).toHaveLength(0);
    expect(fixture.proposalRepository.proposals.find((proposal) => proposal.id === prepared.proposalId)?.status).toBe("pending");
    expect(fixture.proposalRepository.hasApplyClaim(prepared.proposalId)).toBe(false);
  });
});

describe("prepare_directive is an MCP-only tool", () => {
  it("is not offered to the dashboard (Ray) surface, only to the operator MCP surface", async () => {
    const fixture = buildFixture();
    const descriptor = fixture.adapter && createDirectiveReviewedPreparationTool({
      proposalRepository: fixture.proposalRepository, proposalAdapters: [], proposalRecovery: { recoverOperatorMcpProposal: vi.fn() }, auditService: { record: vi.fn() }, now: () => new Date(),
      directiveAuthor: new DirectiveAuthorService({ repository: fixture.directiveRepository as never, textGenerationClient: fixture.textGenerationClient, logger: { info: vi.fn(), warn: vi.fn() }, buildStepScopeTag: (r: string, s: string) => `step:${r}:${s}` }),
      directives: new AuthoredDirectiveService({ repository: fixture.directiveRepository, coherenceChecker: fixture.checker, registeredCapabilityNames: new Set() }),
    }) as CopilotToolDescriptor;
    expect(descriptor.surfaces).toEqual(["mcp"]);

    let capturedTools: ReadonlyArray<{ name: string }> = [];
    const runStreaming = (_request: unknown, tools: ReadonlyArray<{ name: string }>) => {
      capturedTools = tools;
      return { events: (async function* () {})(), result: Promise.resolve({ terminatedReason: "completed" as const, finalMessage: "Done", stepsTaken: 1, toolResultTokensUsed: 0, wallTimeMs: 1 }) };
    };
    const dashboardService = new OperatorCopilotService({
      repository: new MemoryProposalRepository(), capabilityRunner: { runStreaming: runStreaming },
      usageLimitPolicy: { reserveAnswer: vi.fn(async () => ({ commit: vi.fn(async () => {}), release: vi.fn(async () => {}) })), reserveDocument: vi.fn(), reserveIndexedStorage: vi.fn(), reserveMonthlyIndexedContent: vi.fn() },
      auditService: { record: vi.fn() }, prompt: "system", workspaceRouteKeyResolver: { resolveWorkspaceKey: async () => "workspace" },
      currentAuthorization: { hasAllPermissions: async () => true }, tools: [descriptor],
    });
    const runTurnAs = async (surface: CopilotSurface) => {
      const events = [];
      for await (const event of dashboardService.runTurn({
        workspaceId, accountId, operatorUserId, surface, conversationId: null, message: "hi", pageContext, permissions: new Set(["workspace.agents.manage"]),
      })) events.push(event);
    };

    await runTurnAs("dashboard");
    expect(capturedTools.map((tool) => tool.name)).not.toContain("prepare_directive");

    await runTurnAs("mcp");
    expect(capturedTools.map((tool) => tool.name)).toContain("prepare_directive");
  });
});
