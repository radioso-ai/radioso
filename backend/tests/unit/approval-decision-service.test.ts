import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { PostCommitInvalidationReceipt } from "@radioso/workspace-invalidation-contract";

import type {
  PendingDecisionClaim,
  PendingDecisionRecord,
  PendingDecisionRepository,
} from "../../src/db/repositories/pendingDecisionRepository.js";
import {
  ApprovalDecisionService,
  type ApprovalResumeResult,
  type ResumeRunner,
} from "../../src/modules/approvals/public.js";

const decision = (overrides: Partial<PendingDecisionRecord> = {}): PendingDecisionRecord => ({
  id: "decision-row-1",
  handle: "decision_1",
  conversationId: "conversation_1",
  sessionId: "session_1",
  workspaceId: "workspace_1",
  agentId: "agent_1",
  routineId: "routine_1",
  stepId: "approval",
  reason: null,
  options: [
    { id: "approve", label: "Approve" },
    { id: "reject", label: "Reject" },
  ],
  deciderScope: { kind: "workspace_role", role: "admin" },
  contentHash: "hash_1",
  status: "pending",
  decision: null,
  decidedBy: null,
  decidedByUserId: null,
  decidedAt: null,
  deadline: null,
  createdAt: new Date("2026-06-19T00:00:00.000Z"),
  updatedAt: new Date("2026-06-19T00:00:00.000Z"),
  ...overrides,
});

type DecisionStore = Pick<PendingDecisionRepository, "loadByHandle" | "claimInTransaction" | "listPending">;

/** A store whose claim hands out `claimResolve` as the claimed decision's resolution. */
const createRepository = (record: PendingDecisionRecord) => {
  const claimResolve = vi.fn<PendingDecisionClaim["resolve"]>(async () => ({ ...record, status: "resolved" as const }));
  const store = {
    listPending: vi.fn(async () => [record]),
    loadByHandle: vi.fn(async (handle: string) => handle === record.handle ? record : null),
    claimInTransaction: vi.fn(async (_input, callback) => {
      const resume = await callback({ record, resolve: claimResolve }, {});
      return resume;
    }),
  } as unknown as DecisionStore;
  return Object.assign(store, { claimResolve });
};

const noActivity = () => ({ record: vi.fn(async () => undefined) });

/** A resumed turn: it commits its (empty) writes after the decision's resolution, then returns `result`. */
const resumedTurn = (result: Partial<ApprovalResumeResult> = {}): ResumeRunner["resume"] =>
  vi.fn<ResumeRunner["resume"]>(async ({ commit }) => {
    await commit(async () => undefined);
    return {
      conversationId: "conversation_1",
      resumed: true as const,
      assistantMessageId: "assistant_message_1",
      postCommitReceipt: {
        workspaceId: "workspace_1",
        changeKinds: ["conversation.turn_committed"] as const,
      },
      ...result,
    };
  });

const runner = (): ResumeRunner => ({ resume: resumedTurn() });

describe("ApprovalDecisionService role-scoped decisions", () => {
  it("requires every successful resume to return its committed message and invalidation receipt", () => {
    type SuccessfulResume = Awaited<ReturnType<ResumeRunner["resume"]>>;

    expectTypeOf<SuccessfulResume>().toEqualTypeOf<{
      conversationId: string;
      resumed: true;
      assistantMessageId: string;
      postCommitReceipt: PostCommitInvalidationReceipt;
      postCommitWake?: () => void;
    }>();
  });

  it("uses the role resolver when resolving workspace-role scoped decisions", async () => {
    const pending = decision();
    const repository = createRepository(pending);
    const resumeRunner = runner();
    const service = new ApprovalDecisionService(repository, resumeRunner, noActivity(), {
      resolveWorkspaceRole: vi.fn(async () => "admin" as const),
    });

    await expect(service.resolve({
      agentId: pending.agentId,
      handle: pending.handle,
      optionId: "approve",
      contentHash: pending.contentHash,
      caller: { accountId: "account_1", workspaceId: pending.workspaceId },
    })).resolves.toMatchObject({ status: "resolved", optionId: "approve" });

    expect(resumeRunner.resume).toHaveBeenCalledTimes(1);
  });

  it("reports list eligibility with the same role resolver", async () => {
    const pending = decision();
    const repository = createRepository(pending);
    const service = new ApprovalDecisionService(repository, runner(), noActivity(), {
      resolveWorkspaceRole: vi.fn(async () => "member" as const),
    });

    await expect(service.canResolve(pending, {
      accountId: "account_1",
      workspaceId: pending.workspaceId,
    })).resolves.toBe(false);
  });

  it("publishes the resumed assistant message after the decision transaction resolves", async () => {
    const pending = decision();
    const repository = createRepository(pending);
    const resumeRunner = runner();
    const publishMessageCreated = vi.fn();
    const service = new ApprovalDecisionService(
      repository,
      resumeRunner,
      noActivity(),
      { resolveWorkspaceRole: vi.fn(async () => "admin" as const) },
      { publishMessageCreated },
    );

    await service.resolve({
      agentId: pending.agentId,
      handle: pending.handle,
      optionId: "approve",
      contentHash: pending.contentHash,
      caller: { accountId: "account_1", workspaceId: pending.workspaceId },
    });

    expect(vi.mocked(repository.claimInTransaction).mock.invocationCallOrder[0]).toBeLessThan(
      publishMessageCreated.mock.invocationCallOrder[0],
    );
    expect(publishMessageCreated).toHaveBeenCalledWith({
      workspaceId: pending.workspaceId,
      conversationId: pending.conversationId,
      messageId: "assistant_message_1",
      createdAt: expect.any(String),
    });
  });

  it("carries the nested resume receipt to the outer approval transaction owner", async () => {
    const pending = decision();
    const repository = createRepository(pending);
    const resumeRunner = runner();
    const publisher = { enqueue: vi.fn(() => ({ accepted: true as const, coalesced: false })) };
    const service = new ApprovalDecisionService(
      repository,
      resumeRunner,
      noActivity(),
      { resolveWorkspaceRole: vi.fn(async () => "admin" as const) },
      undefined,
      publisher,
    );

    const result = await service.resolve({
      agentId: pending.agentId,
      handle: pending.handle,
      optionId: "approve",
      contentHash: pending.contentHash,
      caller: { accountId: "account_1", workspaceId: pending.workspaceId },
    });

    expect(result).toEqual(expect.objectContaining({ status: "resolved" }));
    expect(publisher.enqueue).toHaveBeenCalledWith(
      pending.workspaceId,
      ["conversation.turn_committed", "hitl.decision_resolved"],
    );
  });

  it("wakes the worker for the resumed turn's background jobs only after the decision transaction commits", async () => {
    const pending = decision();
    const order: string[] = [];
    const repository = {
      ...createRepository(pending),
      claimInTransaction: vi.fn(async (_input, callback: (claim: PendingDecisionClaim, trx: unknown) => Promise<unknown>) => {
        const resume = await callback({ record: pending, resolve: async () => ({ ...pending, status: "resolved" }) }, {});
        order.push("committed");
        return resume;
      }),
    } as unknown as DecisionStore;
    const postCommitWake = vi.fn(() => {
      order.push("woke");
    });
    const resumeRunner: ResumeRunner = { resume: resumedTurn({ postCommitWake }) };
    const service = new ApprovalDecisionService(
      repository,
      resumeRunner,
      noActivity(),
      { resolveWorkspaceRole: vi.fn(async () => "admin" as const) },
    );

    await service.resolve({
      agentId: pending.agentId,
      handle: pending.handle,
      optionId: "approve",
      contentHash: pending.contentHash,
      caller: { accountId: "account_1", workspaceId: pending.workspaceId },
    });

    expect(order).toEqual(["committed", "woke"]);
  });

  it("flushes the outer decision receipt before a fallible conversation event listener", async () => {
    const pending = decision();
    const repository = createRepository(pending);
    const publisher = { enqueue: vi.fn(() => ({ accepted: true as const, coalesced: false })) };
    const publishMessageCreated = vi.fn(() => {
      throw new Error("listener unavailable");
    });
    const service = new ApprovalDecisionService(
      repository,
      runner(),
      noActivity(),
      { resolveWorkspaceRole: vi.fn(async () => "admin" as const) },
      { publishMessageCreated },
      publisher,
    );

    await expect(service.resolve({
      agentId: pending.agentId,
      handle: pending.handle,
      optionId: "approve",
      contentHash: pending.contentHash,
      caller: { accountId: "account_1", workspaceId: pending.workspaceId },
    })).rejects.toThrow("listener unavailable");

    expect(publisher.enqueue).toHaveBeenCalledWith(
      pending.workspaceId,
      ["conversation.turn_committed", "hitl.decision_resolved"],
    );
    expect(publisher.enqueue.mock.invocationCallOrder[0]).toBeLessThan(
      publishMessageCreated.mock.invocationCallOrder[0],
    );
  });

  it("passes the stored option payload into routine resume", async () => {
    const pending = decision({
      options: [
        { id: "approve", label: "Approve", payload: { internalCode: "approve_refund" } },
      ],
    });
    const repository = createRepository(pending);
    const resumeRunner = runner();
    const service = new ApprovalDecisionService(repository, resumeRunner, noActivity(), {
      resolveWorkspaceRole: vi.fn(async () => "admin" as const),
    });

    await service.resolve({
      agentId: pending.agentId,
      handle: pending.handle,
      optionId: "approve",
      contentHash: pending.contentHash,
      caller: { accountId: "account_1", workspaceId: pending.workspaceId },
    });

    expect(resumeRunner.resume).toHaveBeenCalledWith(expect.objectContaining({
      optionId: "approve",
      payload: { internalCode: "approve_refund" },
    }));
  });

  it("records who decided which option in the decision's transaction, once the resumed turn's model work is done and before its reply", async () => {
    const pending = decision();
    const repository = createRepository(pending);
    const activity = noActivity();
    const order: string[] = [];
    repository.claimResolve.mockImplementation(async () => {
      order.push("decision resolved");
      return { ...pending, status: "resolved" };
    });
    activity.record.mockImplementation(async () => {
      order.push("decider recorded");
    });
    const resumeRunner: ResumeRunner = {
      resume: async (input) => {
        order.push("model answered");
        await input.commit(async () => {
          order.push("reply written");
        });
        // Committing again writes the resolution no second time.
        return resumedTurn()(input);
      },
    };
    const service = new ApprovalDecisionService(repository, resumeRunner, activity, {
      resolveWorkspaceRole: vi.fn(async () => "admin" as const),
    });

    await service.resolve({
      agentId: pending.agentId,
      handle: pending.handle,
      optionId: "reject",
      contentHash: pending.contentHash,
      caller: { accountId: "account_1", workspaceId: pending.workspaceId, userId: "user_bea" },
    });

    expect(order).toEqual(["model answered", "decision resolved", "decider recorded", "reply written"]);
    expect(repository.claimResolve).toHaveBeenCalledTimes(1);
    expect(repository.claimResolve).toHaveBeenCalledWith(
      expect.objectContaining({ status: "resolved", decidedBy: "account_1", decidedByUserId: "user_bea" }),
    );
    expect(activity.record).toHaveBeenCalledWith({}, {
      kind: "approval_decided",
      conversationId: pending.conversationId,
      workspaceId: pending.workspaceId,
      actorUserId: "user_bea",
      detail: { handle: pending.handle, decision: { optionId: "reject", label: "Reject" } },
    });
  });

  it("fails the resume, leaving the decision pending, when the resumed turn never commits", async () => {
    const pending = decision();
    const repository = createRepository(pending);
    const resumeRunner: ResumeRunner = {
      resume: vi.fn(async () => ({
        conversationId: pending.conversationId,
        resumed: true as const,
        assistantMessageId: "assistant_message_1",
        postCommitReceipt: { workspaceId: pending.workspaceId, changeKinds: ["conversation.turn_committed"] as const },
      })),
    };
    const service = new ApprovalDecisionService(repository, resumeRunner, noActivity(), {
      resolveWorkspaceRole: vi.fn(async () => "admin" as const),
    });

    await expect(service.resolve({
      agentId: pending.agentId,
      handle: pending.handle,
      optionId: "approve",
      contentHash: pending.contentHash,
      caller: { accountId: "account_1", workspaceId: pending.workspaceId },
    })).rejects.toThrow("approval_resume_resolution_unwritten");
    expect(repository.claimResolve).not.toHaveBeenCalled();
  });

  it("reports the decision not found, writing nothing of the turn, when it is gone by the time the resumed turn commits", async () => {
    const pending = decision();
    const repository = createRepository(pending);
    repository.claimResolve.mockResolvedValue(null);
    const activity = noActivity();
    const work = vi.fn(async () => undefined);
    const resumeRunner: ResumeRunner = {
      resume: async (input) => {
        await input.commit(work);
        return resumedTurn()(input);
      },
    };
    const service = new ApprovalDecisionService(repository, resumeRunner, activity, {
      resolveWorkspaceRole: vi.fn(async () => "admin" as const),
    });

    await expect(service.resolve({
      agentId: pending.agentId,
      handle: pending.handle,
      optionId: "approve",
      contentHash: pending.contentHash,
      caller: { accountId: "account_1", workspaceId: pending.workspaceId },
    })).rejects.toMatchObject({ reason: "not_found" });
    expect(activity.record).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });
});
