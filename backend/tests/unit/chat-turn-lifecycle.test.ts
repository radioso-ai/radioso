import { describe, expect, it, vi } from "vitest";

import type { ConversationTrace } from "@radioso/conversation-contract";

import type { AuditService } from "../../src/modules/audit/contracts/index.js";
import type { ConversationRepositoryPort } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRepositoryPort } from "../../src/db/repositories/messageRepository.js";
import {
  buildTurnTraceForPresentation,
  ChatTurnLifecycle,
  type AssistantTurnPersistencePort,
  type ChatActionOutboxPort,
} from "../../src/modules/chat/services/chatTurnLifecycle.js";
import type { ChatPresentedAnswer } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import { TURN_TRACE_ENVELOPE_VERSION } from "../../src/modules/chat/services/turnTraceEnvelope.js";
import { capabilityNames, type CapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";
import type { ActionCapabilityMap } from "../../src/shared/domain/actionCapabilities.js";

interface RecordedAudit {
  metadata: Record<string, any>;
}

const harness = () => {
  const records: RecordedAudit[] = [];
  const auditService = {
    record: vi.fn(async (event: RecordedAudit) => {
      records.push(event);
    }),
    updateChatAnswerSuggestions: vi.fn(async () => {}),
  } as unknown as AuditService;
  const conversationRepository = {
    touch: vi.fn(async () => {}),
  } as unknown as ConversationRepositoryPort;
  const messageRepository = {
    create: vi.fn(async () => ({ id: "assistant_msg_1" })),
  } as unknown as MessageRepositoryPort;

  const lifecycle = new ChatTurnLifecycle(conversationRepository, messageRepository, auditService);
  return { lifecycle, records };
};

const session = (): PreparedSession =>
  ({
    agent: { id: "agent_1", name: "Support", chatModelOverride: null },
    conversation: { id: "conv_1" },
    history: [],
    userMessage: { id: "msg_1" },
    turnRoute: "social_only",
    directiveSteering: { rules: [], matches: [], omissions: [] },
    stagedContext: [],
    retrieval: {
      contexts: [],
      diagnostics: {},
      systemPrompt: undefined,
      trace: {
        traceId: "trace_1",
        startedAt: "2026-01-01T00:00:00.000Z",
        stages: [],
        links: [],
      },
    },
  } as unknown as PreparedSession);

const presentation = (): ChatPresentedAnswer => ({
  answer: "Grounded answer.",
  skillName: "retrieval.answer",
  skillOutcome: "grounded",
  skillStatus: "completed",
  answerOutcome: "grounded_success",
  citations: [],
});

class FakeActionCapabilityMap implements ActionCapabilityMap {
  constructor(private readonly capabilitiesByType: Map<string, string[]>) {}

  has(type: string): boolean {
    return this.capabilitiesByType.has(type);
  }

  requiredCapabilitiesFor(type: string): string[] {
    return this.capabilitiesByType.get(type) ?? [];
  }
}

class FakeCapabilityPolicy implements CapabilityPolicy {
  readonly checks: string[] = [];

  constructor(private readonly deniedCapabilities = new Set<string>()) {}

  async can(input: { capability: string }): Promise<{ allowed: boolean; reason?: string }> {
    this.checks.push(input.capability);
    return this.deniedCapabilities.has(input.capability)
      ? { allowed: false, reason: "capability_denied" }
      : { allowed: true };
  }
}

const engineTrace = (): ConversationTrace => ({
  traceId: "conversation-turn-1",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
  stages: [
    { id: "gather", kind: "gather", status: "applied" },
    {
      id: "dispatch:retrieval.answer",
      kind: "skill_dispatch",
      status: "applied",
      outputs: { skillName: "retrieval.answer" },
    },
    { id: "compose", kind: "compose", status: "applied" },
  ],
});

describe("ChatTurnLifecycle — engine turn envelope", () => {
  it("builds the same turn trace envelope through the extracted presentation helper", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    const { lifecycle, records } = harness();
    const prepared = session();
    const presented = presentation();
    const answerStartedAt = Date.now() - 1000;

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      session: prepared,
      presentation: presented,
      answerStartedAt,
      stream: false,
      engineTrace: engineTrace(),
    });
    const extracted = buildTurnTraceForPresentation({
      workspaceId: "workspace_1",
      session: prepared,
      presentation: presented,
      answerStartedAt,
      stream: false,
      engineTrace: engineTrace(),
    });

    expect(records[0].metadata.turnTrace).toEqual(extracted.turnTrace);
    expect(records[0].metadata.activityTrace).toEqual(extracted.activityTrace);
    vi.useRealTimers();
  });

  it("uses the transaction port for assistant message, action outbox, routine state, touch, and success audit", async () => {
    const records: RecordedAudit[] = [];
    const auditService = {
      record: vi.fn(async (event: RecordedAudit) => {
        records.push(event);
      }),
      logRecorded: vi.fn((event: RecordedAudit) => {
        records.push(event);
      }),
      updateChatAnswerSuggestions: vi.fn(async () => {}),
    } as unknown as AuditService;
    const conversationRepository = {
      touch: vi.fn(async () => {}),
    } as unknown as ConversationRepositoryPort;
    const messageRepository = {
      create: vi.fn(async () => ({ id: "assistant_msg_separate_write" })),
    } as unknown as MessageRepositoryPort;
    const actionOutbox = {
      enqueue: vi.fn(async () => ({ id: "action_1", duplicate: false })),
    };
    const assistantTurnPersistence: AssistantTurnPersistencePort = {
      completeAssistantTurn: vi.fn(async (input) => ({
        id: input.assistantMessage.id!,
        conversationId: input.assistantMessage.conversationId,
        workspaceId: input.assistantMessage.workspaceId,
        role: "assistant" as const,
        content: input.assistantMessage.content,
        metadata: input.assistantMessage.metadata,
        skillName: input.assistantMessage.skillName,
        skillOutcome: input.assistantMessage.skillOutcome,
        skillStatus: input.assistantMessage.skillStatus,
        createdAt: new Date(),
      })),
    };
    const lifecycle = new ChatTurnLifecycle(
      conversationRepository,
      messageRepository,
      auditService,
      undefined,
      actionOutbox,
      assistantTurnPersistence,
    );

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      accountId: "account_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
      actions: [{ type: "contact.send", payload: { email: "alex@example.com" } }],
      routineStateTransition: { kind: "clear", sessionId: "conv_1" },
      clarificationTransition: {
        kind: "save",
        pending: {
          sessionId: "conv_1",
          source: "test_surface",
          candidates: [{ id: "a", label: "Alpha", confidence: 0.8, payload: { opaque: "a" } }],
          askedEventId: "assistant_msg_1",
          status: "pending",
          expiresAt: "2026-06-10T12:00:00.000Z",
        },
      },
      commitRoutineState: vi.fn(async () => {}),
      commitClarificationState: vi.fn(async () => {}),
    });

    expect(actionOutbox.enqueue).not.toHaveBeenCalled();
    expect(messageRepository.create).not.toHaveBeenCalled();
    expect(conversationRepository.touch).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
    expect(assistantTurnPersistence.completeAssistantTurn).toHaveBeenCalledOnce();
    const persisted = vi.mocked(assistantTurnPersistence.completeAssistantTurn).mock.calls[0]![0];
    expect(persisted.actions).toEqual([{ type: "contact.send", payload: { email: "alex@example.com" } }]);
    expect(persisted.routineStateTransition).toEqual({ kind: "clear", sessionId: "conv_1" });
    expect(persisted.clarificationTransition).toEqual({
      kind: "save",
      pending: {
        sessionId: "conv_1",
        source: "test_surface",
        candidates: [{ id: "a", label: "Alpha", confidence: 0.8, payload: { opaque: "a" } }],
        askedEventId: "assistant_msg_1",
        status: "pending",
        expiresAt: "2026-06-10T12:00:00.000Z",
      },
    });
    expect(persisted.assistantMessage.id).toEqual(expect.any(String));
    expect(persisted.auditEvent.metadata?.assistantMessageId).toBe(persisted.assistantMessage.id);
    expect(records[0]).toBe(persisted.auditEvent);
  });

  it("does not commit a fallback clarification save when assistant message creation fails", async () => {
    const auditService = {
      record: vi.fn(async () => {}),
      updateChatAnswerSuggestions: vi.fn(async () => {}),
    } as unknown as AuditService;
    const conversationRepository = {
      touch: vi.fn(async () => {}),
    } as unknown as ConversationRepositoryPort;
    const messageRepository = {
      create: vi.fn(async () => {
        throw new Error("message write failed");
      }),
    } as unknown as MessageRepositoryPort;
    const commitClarificationState = vi.fn(async () => {});
    const lifecycle = new ChatTurnLifecycle(conversationRepository, messageRepository, auditService);

    await expect(lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
      clarificationTransition: {
        kind: "save",
        pending: {
          sessionId: "conv_1",
          source: "test_surface",
          candidates: [{ id: "a", label: "Alpha", confidence: 0.8, payload: { opaque: "a" } }],
          status: "pending",
          expiresAt: "2026-06-10T12:00:00.000Z",
        },
      },
      commitClarificationState,
    })).rejects.toThrow("message write failed");

    expect(commitClarificationState).not.toHaveBeenCalled();
  });

  it("fails a routine turn with a runtime-denied action before persisting a false success", async () => {
    const auditService = {
      record: vi.fn(async () => {}),
      logRecorded: vi.fn(() => {}),
      updateChatAnswerSuggestions: vi.fn(async () => {}),
    } as unknown as AuditService;
    const conversationRepository = {
      touch: vi.fn(async () => {}),
    } as unknown as ConversationRepositoryPort;
    const messageRepository = {
      create: vi.fn(async () => ({ id: "assistant_msg_separate_write" })),
    } as unknown as MessageRepositoryPort;
    const assistantTurnPersistence: AssistantTurnPersistencePort = {
      completeAssistantTurn: vi.fn(async (input) => ({
        id: input.assistantMessage.id!,
        conversationId: input.assistantMessage.conversationId,
        workspaceId: input.assistantMessage.workspaceId,
        role: "assistant" as const,
        content: input.assistantMessage.content,
        metadata: input.assistantMessage.metadata,
        skillName: input.assistantMessage.skillName,
        skillOutcome: input.assistantMessage.skillOutcome,
        skillStatus: input.assistantMessage.skillStatus,
        createdAt: new Date(),
      })),
    };
    const actionOutbox: ChatActionOutboxPort = {
      enqueue: vi.fn(async () => ({ id: "action_1", duplicate: false })),
    };
    const commitRoutineState = vi.fn(async () => {});
    const commitClarificationState = vi.fn(async () => {});
    const logger = {
      warn: vi.fn(),
    };
    const lifecycle = new ChatTurnLifecycle(
      conversationRepository,
      messageRepository,
      auditService,
      undefined,
      actionOutbox,
      assistantTurnPersistence,
      new FakeActionCapabilityMap(new Map([
        ["contact.send", [capabilityNames.humanContact.request]],
        ["ticket.create", []],
      ])),
      new FakeCapabilityPolicy(new Set([capabilityNames.humanContact.request])),
      logger,
    );

    await expect(lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      accountId: "account_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      actions: [
        { type: "contact.send", payload: { email: "alex@example.com" } },
        { type: "ticket.create", payload: { title: "Keep this one" } },
      ],
      routineStateTransition: { kind: "clear", sessionId: "conv_1" },
      commitRoutineState,
      clarificationTransition: {
        kind: "save",
        pending: {
          sessionId: "conv_1",
          source: "test_surface",
          candidates: [{ id: "a", label: "Alpha", confidence: 0.8, payload: {} }],
          status: "pending",
          expiresAt: "2026-06-10T12:00:00.000Z",
        },
      },
      commitClarificationState,
    })).rejects.toThrow("routine_action_authorization_denied");

    expect(assistantTurnPersistence.completeAssistantTurn).not.toHaveBeenCalled();
    expect(messageRepository.create).not.toHaveBeenCalled();
    expect(actionOutbox.enqueue).not.toHaveBeenCalled();
    expect(commitRoutineState).not.toHaveBeenCalled();
    expect(commitClarificationState).not.toHaveBeenCalled();
    expect(auditService.logRecorded).not.toHaveBeenCalled();
    expect(auditService.record).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      {
        workspaceId: "workspace_1",
        conversationId: "conv_1",
        actionType: "contact.send",
        reason: "capability_denied",
        capability: capabilityNames.humanContact.request,
      },
      "Routine action blocked by capability policy",
    );
  });

  it("enqueues an authorized action unchanged on the fallback outbox path", async () => {
    const records: RecordedAudit[] = [];
    const auditService = {
      record: vi.fn(async (event: RecordedAudit) => {
        records.push(event);
      }),
      updateChatAnswerSuggestions: vi.fn(async () => {}),
    } as unknown as AuditService;
    const conversationRepository = {
      touch: vi.fn(async () => {}),
    } as unknown as ConversationRepositoryPort;
    const messageRepository = {
      create: vi.fn(async () => ({ id: "assistant_msg_1" })),
    } as unknown as MessageRepositoryPort;
    const actionOutbox: ChatActionOutboxPort = {
      enqueue: vi.fn(async () => ({ id: "action_1", duplicate: false })),
    };
    const lifecycle = new ChatTurnLifecycle(
      conversationRepository,
      messageRepository,
      auditService,
      undefined,
      actionOutbox,
      undefined,
      new FakeActionCapabilityMap(new Map([
        ["contact.send", [capabilityNames.humanContact.request]],
      ])),
      new FakeCapabilityPolicy(),
    );

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      accountId: "account_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      actions: [{ type: "contact.send", payload: { email: "alex@example.com" } }],
      clarificationTransition: {
        kind: "clear",
        sessionId: "conv_1",
        outcome: "resolved",
      },
      commitClarificationState: vi.fn(async () => {}),
    });

    expect(actionOutbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      type: "contact.send",
      payload: { email: "alex@example.com" },
      workspaceId: "workspace_1",
      accountId: "account_1",
      conversationId: "conv_1",
      idempotencyKey: expect.stringMatching(/^routine-action:conv_1:contact\.send:/),
    }));
    expect(records).toHaveLength(1);
  });

  it("commits clarification state on the fallback path after the assistant message", async () => {
    const order: string[] = [];
    const auditService = {
      record: vi.fn(async () => {
        order.push("audit");
      }),
      updateChatAnswerSuggestions: vi.fn(async () => {}),
    } as unknown as AuditService;
    const conversationRepository = {
      touch: vi.fn(async () => {
        order.push("touch");
      }),
    } as unknown as ConversationRepositoryPort;
    const messageRepository = {
      create: vi.fn(async () => {
        order.push("message");
        return { id: "assistant_msg_1" };
      }),
    } as unknown as MessageRepositoryPort;
    const actionOutbox: ChatActionOutboxPort = {
      enqueue: vi.fn(async () => {
        order.push("action");
        return { id: "action_1", duplicate: false };
      }),
    };
    const commitClarificationState = vi.fn(async () => {
      order.push("clarification");
    });
    const lifecycle = new ChatTurnLifecycle(
      conversationRepository,
      messageRepository,
      auditService,
      undefined,
      actionOutbox,
    );

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      accountId: "account_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      actions: [{ type: "contact.send", payload: { email: "alex@example.com" } }],
      clarificationTransition: {
        kind: "save",
        pending: {
          sessionId: "conv_1",
          source: "test_surface",
          candidates: [{ id: "a", label: "Alpha", confidence: 0.8, payload: {} }],
          status: "pending",
          expiresAt: "2026-06-10T12:00:00.000Z",
        },
      },
      commitClarificationState,
    });

    expect(commitClarificationState).toHaveBeenCalledOnce();
    expect(order.slice(0, 3)).toEqual(["action", "message", "clarification"]);
  });

  it("persists a turnTrace envelope with the retrieval activity trace as a leaf on the dispatch stage", async () => {
    const { lifecycle, records } = harness();

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
    });

    expect(records).toHaveLength(1);
    const { turnTrace } = records[0].metadata;
    expect(turnTrace.version).toBe(TURN_TRACE_ENVELOPE_VERSION);
    expect(turnTrace.spine.stages.map((stage: any) => stage.kind)).toEqual([
      "gather",
      "skill_dispatch",
      "compose",
    ]);

    const dispatchStage = turnTrace.spine.stages.find((stage: any) => stage.kind === "skill_dispatch");
    expect(dispatchStage.subTrace.namespace).toBe("retrieval");
    expect(dispatchStage.subTrace.version).toBe(1);
    // The leaf is the FINALIZED activity trace (answer-outcome stage appended), keyed off trace_1.
    expect(dispatchStage.subTrace.payload.traceId).toBe("trace_1");
    expect(dispatchStage.subTrace.payload.stages.length).toBeGreaterThan(0);
  });

  it("retains the legacy activityTrace key but no longer writes conversationEngine.trace", async () => {
    const { lifecycle, records } = harness();

    await lifecycle.completeAssistantTurn({
      workspaceId: "workspace_1",
      session: session(),
      presentation: presentation(),
      answerStartedAt: Date.now(),
      stream: false,
      engineTrace: engineTrace(),
    });

    const { metadata } = records[0];
    // Legacy flat trace is still written (history + live text diagnostics read it).
    expect(metadata.activityTrace?.traceId).toBe("trace_1");
    // The raw spine now lives only in the envelope; the dead audit key is gone.
    expect(metadata.conversationEngine).toBeUndefined();
    expect(metadata.turnTrace?.spine?.traceId).toBe("conversation-turn-1");
  });
});
