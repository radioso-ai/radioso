import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { CreateSnapshotInput } from "../../src/modules/eval/services/evalRepository.js";
import {
  EvalMessageCaseService,
  type EvalMessageCaseRepositoryPort,
} from "../../src/modules/eval/services/evalMessageCaseService.js";
import type {
  EvalCase,
  EvalMessageCaseLookup,
  EvalMessageCaseVerification,
  EvalSnapshot,
} from "../../src/modules/eval/domain/types.js";

const capturedAt = "2026-07-30T10:00:00.000Z";

const preparedSnapshot = (input: {
  workspaceId: string;
  conversationId: string;
  assistantMessageId: string;
  capturedBy?: string | null;
}): CreateSnapshotInput => ({
  workspaceId: input.workspaceId,
  sourceConversationId: input.conversationId,
  sourceMessageId: input.assistantMessageId,
  replayTarget: {
    userMessageId: "11111111-1111-4111-8111-111111111111",
    assistantMessageId: input.assistantMessageId,
  },
  fidelity: "messages_only",
  messages: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      role: "user",
      content: "What is the refund policy?",
      createdAt: "2026-07-30T09:59:00.000Z",
    },
    {
      id: input.assistantMessageId,
      role: "assistant",
      content: "Refunds are available within seven days.",
      createdAt: capturedAt,
    },
  ],
  originalInstructionBlock: null,
  originalModelId: null,
  originalRetrievalSettings: null,
  originalRetrievalResult: null,
  originalAgent: null,
  originalAgentConfig: null,
  sourceAgentId: null,
  originalRoutineState: null,
  capturedBy: input.capturedBy ?? null,
});

const linked = (input: {
  workspaceId: string;
  assistantMessageId: string;
  caseId?: string;
  snapshotId?: string;
}): EvalMessageCaseLookup => {
  const snapshotId = input.snapshotId ?? randomUUID();
  const caseId = input.caseId ?? randomUUID();
  const snapshot: EvalSnapshot = {
    id: snapshotId,
    capturedAt,
    ...preparedSnapshot({
      workspaceId: input.workspaceId,
      conversationId: randomUUID(),
      assistantMessageId: input.assistantMessageId,
    }),
  };
  const evalCase: EvalCase = {
    id: caseId,
    workspaceId: input.workspaceId,
    snapshotId,
    name: "2026-07-30 · What is the refund policy?",
    assertions: [],
    status: "pending",
    lastRunId: null,
    createdAt: capturedAt,
    updatedAt: capturedAt,
  };
  return {
    assistantMessageId: input.assistantMessageId,
    case: evalCase,
    snapshot,
    createdBy: null,
    createdAt: capturedAt,
  };
};

const repository = (
  overrides: Partial<EvalMessageCaseRepositoryPort> = {},
): EvalMessageCaseRepositoryPort => ({
  findSourceMessage: vi.fn().mockResolvedValue(null),
  findMessageCase: vi.fn().mockResolvedValue(null),
  findOrCreateMessageCase: vi.fn(),
  lookupMessageCaseVerifications: vi.fn().mockResolvedValue(new Map()),
  ...overrides,
});

describe("EvalMessageCaseService", () => {
  it("returns an existing association without preparing or mutating a snapshot", async () => {
    const workspaceId = randomUUID();
    const assistantMessageId = randomUUID();
    const existing = linked({ workspaceId, assistantMessageId });
    const repo = repository({
      findMessageCase: vi.fn().mockResolvedValue(existing),
      findSourceMessage: vi.fn().mockResolvedValue({
        id: assistantMessageId,
        conversationId: existing.snapshot.sourceConversationId,
        role: "assistant",
        source: "ai_agent",
        createdAt: new Date(capturedAt),
      }),
    });
    const prepare = vi.fn();
    const service = new EvalMessageCaseService(repo, { prepare });

    const result = await service.findOrCreate({
      workspaceId,
      assistantMessageId,
      createdBy: randomUUID(),
    });

    expect(result).toEqual({ ...existing, created: false });
    expect(prepare).not.toHaveBeenCalled();
    expect(repo.findOrCreateMessageCase).not.toHaveBeenCalled();
  });

  it("validates authorship before returning an existing association", async () => {
    const workspaceId = randomUUID();
    const assistantMessageId = randomUUID();
    const existing = linked({ workspaceId, assistantMessageId });
    const repo = repository({
      findMessageCase: vi.fn().mockResolvedValue(existing),
      findSourceMessage: vi.fn().mockResolvedValue({
        id: assistantMessageId,
        conversationId: existing.snapshot.sourceConversationId,
        role: "assistant",
        source: "human_agent",
        createdAt: new Date(capturedAt),
      }),
    });
    const prepare = vi.fn();
    const service = new EvalMessageCaseService(repo, { prepare });

    await expect(service.findOrCreate({ workspaceId, assistantMessageId }))
      .rejects.toMatchObject({
        code: "bad_request",
        message: "Source message must be an AI-authored assistant message",
      });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("derives the conversation, prepares one immutable snapshot, and delegates atomic creation", async () => {
    const workspaceId = randomUUID();
    const assistantMessageId = randomUUID();
    const conversationId = randomUUID();
    const createdBy = randomUUID();
    const prepared = preparedSnapshot({
      workspaceId,
      conversationId,
      assistantMessageId,
      capturedBy: createdBy,
    });
    const created = linked({ workspaceId, assistantMessageId });
    const repo = repository({
      findSourceMessage: vi.fn().mockResolvedValue({
        id: assistantMessageId,
        conversationId,
        role: "assistant",
        source: "ai_agent",
        createdAt: new Date(capturedAt),
      }),
      findOrCreateMessageCase: vi.fn().mockResolvedValue({ ...created, created: true }),
    });
    const prepare = vi.fn().mockResolvedValue(prepared);
    const service = new EvalMessageCaseService(repo, { prepare });

    await expect(service.findOrCreate({
      workspaceId,
      assistantMessageId,
      createdBy,
    })).resolves.toEqual({ ...created, created: true });

    expect(prepare).toHaveBeenCalledWith({
      workspaceId,
      conversationId,
      messageId: assistantMessageId,
      capturedBy: createdBy,
    });
    expect(repo.findOrCreateMessageCase).toHaveBeenCalledWith({
      workspaceId,
      assistantMessageId,
      createdBy,
      snapshot: prepared,
      caseName: '2026-07-30 · "What is the refund policy?"',
    });
  });

  it("rejects missing, non-assistant, and human-authored source messages", async () => {
    const workspaceId = randomUUID();
    const assistantMessageId = randomUUID();

    const missing = new EvalMessageCaseService(repository(), { prepare: vi.fn() });
    await expect(missing.findOrCreate({ workspaceId, assistantMessageId })).rejects.toMatchObject({
      code: "not_found",
      message: "Assistant message not found",
    });

    for (const sourceMessage of [
      {
        id: assistantMessageId,
        conversationId: randomUUID(),
        role: "user" as const,
        source: "customer" as const,
        createdAt: new Date(capturedAt),
      },
      {
        id: assistantMessageId,
        conversationId: randomUUID(),
        role: "assistant" as const,
        source: "human_agent" as const,
        createdAt: new Date(capturedAt),
      },
      ...["customer", "system", "unexpected_source"].map((source) => ({
        id: assistantMessageId,
        conversationId: randomUUID(),
        role: "assistant" as const,
        source,
        createdAt: new Date(capturedAt),
      })),
    ]) {
      const service = new EvalMessageCaseService(repository({
        findSourceMessage: vi.fn().mockResolvedValue(sourceMessage),
      }), { prepare: vi.fn() });
      await expect(service.findOrCreate({ workspaceId, assistantMessageId })).rejects.toMatchObject({
        code: "bad_request",
        message: "Source message must be an AI-authored assistant message",
      });
    }
  });

  it("rejects an assistant turn that has no matching replayable user turn", async () => {
    const workspaceId = randomUUID();
    const assistantMessageId = randomUUID();
    const conversationId = randomUUID();
    const prepared = {
      ...preparedSnapshot({ workspaceId, conversationId, assistantMessageId }),
      sourceMessageId: null,
      replayTarget: null,
    };
    const repo = repository({
      findSourceMessage: vi.fn().mockResolvedValue({
        id: assistantMessageId,
        conversationId,
        role: "assistant",
        source: "ai_agent",
        createdAt: new Date(capturedAt),
      }),
    });
    const service = new EvalMessageCaseService(repo, {
      prepare: vi.fn().mockResolvedValue(prepared),
    });

    await expect(service.findOrCreate({ workspaceId, assistantMessageId }))
      .rejects.toMatchObject({
        code: "bad_request",
        message: "Assistant message has no preceding user message to replay",
      });
    expect(repo.findOrCreateMessageCase).not.toHaveBeenCalled();
  });

  it("performs read-only lookup without creating an association", async () => {
    const workspaceId = randomUUID();
    const assistantMessageId = randomUUID();
    const existing = linked({ workspaceId, assistantMessageId });
    const repo = repository({
      findMessageCase: vi.fn().mockResolvedValue(existing),
    });
    const service = new EvalMessageCaseService(repo, { prepare: vi.fn() });

    await expect(service.get(workspaceId, assistantMessageId)).resolves.toEqual(existing);
    expect(repo.findOrCreateMessageCase).not.toHaveBeenCalled();

    vi.mocked(repo.findMessageCase).mockResolvedValueOnce(null);
    await expect(service.get(workspaceId, randomUUID())).rejects.toMatchObject({
      code: "not_found",
      message: "Eval case association not found",
    });
  });

  it("deduplicates a bounded verification batch without changing lookup meaning", async () => {
    const workspaceId = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    const expected = new Map<string, EvalMessageCaseVerification>([
      [first, {
        caseId: randomUUID(),
        caseStatus: "passing",
        latestRunStatus: "pass",
        latestRunAt: capturedAt,
      }],
    ]);
    const repo = repository({
      lookupMessageCaseVerifications: vi.fn().mockResolvedValue(expected),
    });
    const service = new EvalMessageCaseService(repo, { prepare: vi.fn() });

    await expect(service.lookupVerifications(workspaceId, [first, second, first]))
      .resolves.toEqual(expected);
    expect(repo.lookupMessageCaseVerifications).toHaveBeenCalledWith(workspaceId, [first, second]);

    await expect(
      service.lookupVerifications(
        workspaceId,
        Array.from({ length: 101 }, () => randomUUID()),
      ),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: "At most 100 assistant message ids may be looked up at once",
    });
  });
});
