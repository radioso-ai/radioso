import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { PostCommitInvalidationReceipt } from "@radioso/workspace-invalidation-contract";

import type {
  PendingDecisionRecord,
  PendingDecisionRepository,
} from "../../src/db/repositories/pendingDecisionRepository.js";
import {
  ApprovalDecisionService,
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
  decidedAt: null,
  deadline: null,
  createdAt: new Date("2026-06-19T00:00:00.000Z"),
  updatedAt: new Date("2026-06-19T00:00:00.000Z"),
  ...overrides,
});

const createRepository = (record: PendingDecisionRecord) => ({
  listPending: vi.fn(async () => [record]),
  loadByHandle: vi.fn(async (handle: string) => handle === record.handle ? record : null),
  resolveInTransaction: vi.fn(async (_input, callback) => {
    const resume = await callback(record, {});
    return resume;
  }),
}) as unknown as Pick<PendingDecisionRepository, "loadByHandle" | "resolveInTransaction" | "listPending">;

const runner = (): ResumeRunner => ({
  resume: vi.fn(async () => ({
    conversationId: "conversation_1",
    resumed: true as const,
    assistantMessageId: "assistant_message_1",
    postCommitReceipt: {
      workspaceId: "workspace_1",
      changeKinds: ["conversation.turn_committed"] as const,
    },
  })),
});

describe("ApprovalDecisionService role-scoped decisions", () => {
  it("requires every successful resume to return its committed message and invalidation receipt", () => {
    type SuccessfulResume = Awaited<ReturnType<ResumeRunner["resume"]>>;

    expectTypeOf<SuccessfulResume>().toEqualTypeOf<{
      conversationId: string;
      resumed: true;
      assistantMessageId: string;
      postCommitReceipt: PostCommitInvalidationReceipt;
    }>();
  });

  it("uses the role resolver when resolving workspace-role scoped decisions", async () => {
    const pending = decision();
    const repository = createRepository(pending);
    const resumeRunner = runner();
    const service = new ApprovalDecisionService(repository, resumeRunner, {
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
    const service = new ApprovalDecisionService(repository, runner(), {
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
    const resumeRunner: ResumeRunner = {
      resume: vi.fn(async () => ({
        conversationId: pending.conversationId,
        resumed: true as const,
        assistantMessageId: "assistant_message_1",
        postCommitReceipt: {
          workspaceId: pending.workspaceId,
          changeKinds: ["conversation.turn_committed"] as const,
        },
      })),
    };
    const publishMessageCreated = vi.fn();
    const service = new ApprovalDecisionService(
      repository,
      resumeRunner,
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

    expect(vi.mocked(repository.resolveInTransaction).mock.invocationCallOrder[0]).toBeLessThan(
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
    const resumeRunner: ResumeRunner = {
      resume: vi.fn(async () => ({
        conversationId: pending.conversationId,
        resumed: true as const,
        assistantMessageId: "assistant_message_1",
        postCommitReceipt: {
          workspaceId: pending.workspaceId,
          changeKinds: ["conversation.turn_committed"] as const,
        },
      })),
    };
    const publisher = { enqueue: vi.fn(() => ({ accepted: true as const, coalesced: false })) };
    const service = new ApprovalDecisionService(
      repository,
      resumeRunner,
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

  it("flushes the outer decision receipt before a fallible conversation event listener", async () => {
    const pending = decision();
    const repository = createRepository(pending);
    const publisher = { enqueue: vi.fn(() => ({ accepted: true as const, coalesced: false })) };
    const publishMessageCreated = vi.fn(() => {
      throw new Error("listener unavailable");
    });
    const service = new ApprovalDecisionService(
      repository,
      {
        resume: vi.fn(async () => ({
          conversationId: pending.conversationId,
          resumed: true as const,
          assistantMessageId: "assistant_message_1",
          postCommitReceipt: {
            workspaceId: pending.workspaceId,
            changeKinds: ["conversation.turn_committed"] as const,
          },
        })),
      },
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
    const service = new ApprovalDecisionService(repository, resumeRunner, {
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
});
