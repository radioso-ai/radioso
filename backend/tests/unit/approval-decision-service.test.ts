import { describe, expect, it, vi } from "vitest";

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
    { id: "approve", label: "Approve", payload: { outcome: "approved" } },
    { id: "reject", label: "Reject", payload: { outcome: "rejected" } },
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
    const resume = await callback(record, {} as never);
    return { conversationId: resume.conversationId, resumed: resume.resumed };
  }),
}) as unknown as Pick<PendingDecisionRepository, "loadByHandle" | "resolveInTransaction" | "listPending">;

const runner = (): ResumeRunner => ({
  resume: vi.fn(async () => ({ conversationId: "conversation_1", resumed: true })),
});

describe("ApprovalDecisionService role-scoped decisions", () => {
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
    })).resolves.toMatchObject({ status: "resolved", decision: "approved" });

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
});
