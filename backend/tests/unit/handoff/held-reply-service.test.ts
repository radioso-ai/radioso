import { describe, expect, it, vi } from "vitest";

import type { ConversationRecord } from "../../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../../src/db/repositories/messageRepository.js";
import type { ConversationActivityEvent } from "../../../src/modules/conversationActivity/contracts/index.js";
import type { CustomerReplyRoute } from "../../../src/modules/customerReplyDelivery/public.js";
import {
  heldReplyEventSources,
  heldReplyEventTarget,
  HeldReplyService,
  isHeldReplyAttentionOpen,
  OperatorReplyService,
  type HeldReplyChannelScope,
  type HeldReplyInsert,
  type HeldReplyReadStore,
  type HeldReplyRecord,
  type HeldReplyWriteStore,
  type HoldReplyInput,
  type OwnershipActor,
} from "../../../src/modules/handoff/public.js";
import { InMemoryConversationOwnershipRepository } from "../../support/fakes.js";

const workspaceId = "workspace-1";
const accountId = "account-1";
const conversationId = "conversation-1";
const inboundId = "message-inbound-1";
const policyRef = "email_mailbox:mailbox-1";
const draftText = "Your refund was issued on Monday.";
const draftPresentation = { citations: [{ documentId: "doc-1" }], grounding: { verdict: "grounded" } };

const dana: OwnershipActor = { accountId, workspaceId, userId: "user-dana" };

const conversation = { id: conversationId, workspaceId, sourceChannel: "email", channelContext: null } as unknown as ConversationRecord;

const holdInput = (overrides: Partial<HoldReplyInput> = {}): HoldReplyInput => ({
  workspaceId,
  conversationId,
  agentId: "agent-1",
  answersMessageId: inboundId,
  ownershipVersion: 0,
  policy: { ref: policyRef, version: 5 },
  reviewRef: `email:${conversationId}:1`,
  holdReason: "draft_mode",
  facts: {
    outcome: "answered",
    grounding: "grounded",
    coverage: "answered",
    handoff: { requested: false },
    suppressedEffects: [{ skillName: "issue_refund" }],
    citationCount: 1,
  },
  draft: { text: draftText, presentation: draftPresentation },
  ...overrides,
});

/** The held-reply rows as the repository keeps them: each conditional write applies only from its states. */
class InMemoryHeldReplies implements HeldReplyWriteStore, HeldReplyReadStore {
  readonly rows = new Map<string, HeldReplyRecord>();
  readonly latestCustomerMessage = new Map<string, string>([[conversationId, inboundId]]);
  /** Makes the next conditional release lose to a concurrent one that committed first. */
  loseNextReleaseTo: "released" | null = null;
  /** Makes the next conditional materialization lose to a change that superseded the queued send first. */
  loseNextMaterializeTo: "superseded" | null = null;
  private sequence = 0;
  private clock = Date.parse("2026-10-04T10:00:00.000Z");

  constructor(private readonly steps: string[]) {}

  seed(overrides: Partial<HeldReplyRecord>): HeldReplyRecord {
    const record = this.newRecord(holdInput(), overrides);
    this.rows.set(record.id, record);
    return record;
  }

  async insert(input: HeldReplyInsert): Promise<{ record: HeldReplyRecord; created: boolean }> {
    const existing = [...this.rows.values()].find((row) =>
      input.reviewRef !== null && row.conversationId === input.conversationId && row.reviewRef === input.reviewRef);
    if (existing) {
      return { record: existing, created: false };
    }
    const superseded = input.born.state === "superseded"
      ? {
          state: "superseded" as const,
          supersededReason: input.born.reason,
          attentionClearedAt: new Date(this.clock),
          attentionClearedReason: heldReplyEventTarget({ kind: "supersede", reason: input.born.reason }).attentionCleared,
          decidedAt: new Date(this.clock),
        }
      : input.born.state === "queued_auto" ? { state: "queued_auto" as const } : {};
    const record = this.newRecord(input, superseded);
    this.rows.set(record.id, record);
    return { record, created: true };
  }

  async findInConversation(inConversation: string, id: string): Promise<HeldReplyRecord | null> {
    const row = this.rows.get(id);
    return row?.conversationId === inConversation ? row : null;
  }

  async findById(id: string): Promise<HeldReplyRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async materialize(input: Parameters<HeldReplyWriteStore["materialize"]>[0]): Promise<HeldReplyRecord | null> {
    this.steps.push("materialize_held_reply");
    const row = await this.findInConversation(input.conversationId, input.id);
    if (row && this.loseNextMaterializeTo) {
      this.rows.set(row.id, { ...row, state: this.loseNextMaterializeTo, supersededReason: "takeover" });
      this.loseNextMaterializeTo = null;
      return null;
    }
    if (!row || !heldReplyEventSources("materialize").includes(row.state)) {
      return null;
    }
    const target = heldReplyEventTarget({ kind: "materialize", authorized: input.authorized });
    const settled: HeldReplyRecord = {
      ...row,
      state: target.state,
      releaseKind: target.releaseKind,
      holdReason: target.holdReason ?? row.holdReason,
      attentionClearedAt: target.attentionCleared === null ? null : new Date(this.clock),
      attentionClearedReason: target.attentionCleared,
      decidedAt: input.authorized ? new Date(this.clock) : null,
    };
    this.rows.set(row.id, settled);
    return settled;
  }

  async latestCustomerMessageId(inConversation: string): Promise<string | null> {
    return this.latestCustomerMessage.get(inConversation) ?? null;
  }

  async release(input: Parameters<HeldReplyWriteStore["release"]>[0]): Promise<HeldReplyRecord | null> {
    this.steps.push("release_held_reply");
    const row = await this.findInConversation(input.conversationId, input.id);
    if (row && this.loseNextReleaseTo) {
      this.rows.set(row.id, { ...row, state: this.loseNextReleaseTo, releaseKind: "operator", releaserUserId: "user-fox" });
      this.loseNextReleaseTo = null;
      return null;
    }
    if (!row || !heldReplyEventSources("release").includes(row.state) || row.ownershipVersion !== input.ownershipVersion) {
      return null;
    }
    const edited = input.editedText !== null;
    const target = heldReplyEventTarget({ kind: "release", edited });
    const released: HeldReplyRecord = {
      ...row,
      state: target.state,
      releaseKind: target.releaseKind,
      editedText: input.editedText,
      editorUserId: edited ? input.userId : null,
      releaserUserId: input.userId,
      attentionClearedAt: new Date(this.clock),
      attentionClearedReason: target.attentionCleared,
      decidedAt: new Date(this.clock),
    };
    this.rows.set(row.id, released);
    return released;
  }

  async attachReleasedMessage(id: string, messageId: string): Promise<HeldReplyRecord> {
    const row = this.rows.get(id)!;
    const linked = { ...row, releasedMessageId: messageId };
    this.rows.set(id, linked);
    return linked;
  }

  async discard(input: Parameters<HeldReplyWriteStore["discard"]>[0]): Promise<HeldReplyRecord | null> {
    const row = await this.findInConversation(input.conversationId, input.id);
    if (!row || !heldReplyEventSources("discard").includes(row.state)) {
      return null;
    }
    const discarded = { ...row, state: "discarded" as const, discardedByUserId: input.userId, decidedAt: new Date(this.clock) };
    this.rows.set(row.id, discarded);
    return discarded;
  }

  async findByReviewRef(inConversation: string, reviewRef: string): Promise<HeldReplyRecord | null> {
    return [...this.rows.values()].find((row) => row.conversationId === inConversation && row.reviewRef === reviewRef) ?? null;
  }

  async current(inWorkspace: string, inConversation: string): Promise<HeldReplyRecord | null> {
    return this.newestFirst().find((row) => row.workspaceId === inWorkspace && row.conversationId === inConversation) ?? null;
  }

  async listOpen(inWorkspace: string, query: Parameters<HeldReplyReadStore["listOpen"]>[1]): Promise<HeldReplyRecord[]> {
    return this.list(inWorkspace, query).filter(isHeldReplyAttentionOpen).slice(0, query.limit);
  }

  async listAll(inWorkspace: string, query: Parameters<HeldReplyReadStore["listAll"]>[1]): Promise<HeldReplyRecord[]> {
    return this.list(inWorkspace, query).slice(0, query.limit);
  }

  private list(inWorkspace: string, query: Parameters<HeldReplyReadStore["listAll"]>[1]): HeldReplyRecord[] {
    const { after } = query;
    return this.newestFirst().filter((row) => row.workspaceId === inWorkspace
      && (query.agentId === undefined || row.agentId === query.agentId)
      && (!after || row.createdAt < after.createdAt || (row.createdAt.getTime() === after.createdAt.getTime() && row.id < after.id)));
  }

  private newestFirst(): HeldReplyRecord[] {
    return [...this.rows.values()].sort((left, right) =>
      right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id));
  }

  private newRecord(input: Omit<HeldReplyInsert, "born">, overrides: Partial<HeldReplyRecord>): HeldReplyRecord {
    this.sequence += 1;
    this.clock += 1000;
    return {
      id: `held-${this.sequence}`,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      state: "pending",
      releaseKind: null,
      reviewRef: input.reviewRef,
      answersMessageId: input.answersMessageId,
      ownershipVersion: input.ownershipVersion,
      policy: input.policy,
      holdReason: input.holdReason,
      facts: input.facts,
      draft: input.draft,
      editedText: null,
      editorUserId: null,
      releaserUserId: null,
      discardedByUserId: null,
      releasedMessageId: null,
      supersededReason: null,
      attentionClearedAt: null,
      attentionClearedReason: null,
      decidedAt: null,
      createdAt: new Date(this.clock),
      ...overrides,
    };
  }
}

/** What the fake channel answers: its locked policy version, whether a send fits the budget, and its dispatch verdict. */
interface FakeChannelState {
  lockedPolicyVersion: number | null;
  sendBudgetLeft: boolean;
  dispatch: { authorized: true } | { authorized: false; code: string };
}

const createService = (options: {
  route?: "email" | "none";
  channel?: "registered" | "unregistered";
  lockedPolicyVersion?: number | null;
} = {}) => {
  const steps: string[] = [];
  const heldReplies = new InMemoryHeldReplies(steps);
  const ownership = new InMemoryConversationOwnershipRepository();
  const takeOver = vi.spyOn(ownership, "takeOver");
  const channelState: FakeChannelState = {
    lockedPolicyVersion: options.lockedPolicyVersion === undefined ? 5 : options.lockedPolicyVersion,
    sendBudgetLeft: true,
    dispatch: { authorized: true },
  };
  const channelScope: HeldReplyChannelScope = {
    lockPolicy: vi.fn(async () => {
      steps.push("lock_policy");
      return channelState.lockedPolicyVersion === null ? null : { version: channelState.lockedPolicyVersion };
    }),
    reserveAutoSend: vi.fn(async () => {
      steps.push("reserve_auto_send");
      return channelState.sendBudgetLeft;
    }),
    enqueueAutoSend: vi.fn(async (heldReply, onOutbox) => {
      await onOutbox.enqueue({
        type: "email.send",
        payload: { trigger: "auto_reply", heldReplyId: heldReply.id, messageId: null },
        idempotencyKey: `email:send:held:${heldReply.id}`,
      });
    }),
    authorizeAutoDispatch: vi.fn(async () => {
      steps.push("authorize_auto_dispatch");
      return channelState.dispatch;
    }),
    recordMaterialized: vi.fn(async () => {
      steps.push("record_materialized");
    }),
    enqueueRelease: vi.fn(async (heldReply, messageId, onOutbox) => {
      await onOutbox.enqueue({
        type: "email.send",
        payload: { trigger: "held_release", heldReplyId: heldReply.id, messageId },
        idempotencyKey: `email:send:msg:${messageId}`,
      });
    }),
  };
  const outbox = {
    enqueue: vi.fn(async (input: { idempotencyKey?: string | null }) => {
      steps.push(`enqueue:${input.idempotencyKey}`);
      return { id: "action-1", duplicate: false };
    }),
  };
  const route: CustomerReplyRoute = {
    enqueue: vi.fn(async (onOutbox, message) => {
      await onOutbox.enqueue({ type: "email.send", payload: { messageId: message.id }, idempotencyKey: `email:send:msg:${message.id}` });
    }),
  };
  const customerReplyDelivery = {
    route: vi.fn(async () => (options.route === "none" ? null : route)),
  };
  let messageSequence = 0;
  const messages: MessageRecord[] = [];
  const messageRecord = (input: Partial<MessageRecord> & { content: string }): MessageRecord => {
    messageSequence += 1;
    const message: MessageRecord = {
      id: `message-out-${messageSequence}`,
      conversationId,
      workspaceId,
      role: "assistant",
      createdAt: new Date("2026-10-04T10:05:00.000Z"),
      ...input,
    };
    messages.push(message);
    return message;
  };
  const replyScope = {
    messages: {
      create: vi.fn(async (input: { content: string; source?: MessageRecord["source"]; operatorUserId?: string }) => {
        steps.push("write_message");
        return messageRecord({ content: input.content, source: input.source, metadata: { operatorUserId: input.operatorUserId } });
      }),
    },
    conversations: { touch: vi.fn(async () => undefined) },
    outbox,
  };
  const drafts = {
    writeAgentMessage: vi.fn(async (input: { draft: { text: string; presentation: Readonly<Record<string, unknown>> } }) => {
      steps.push("write_message");
      return messageRecord({ content: input.draft.text, source: "ai_agent", metadata: { ...input.draft.presentation } });
    }),
  };
  const activityEvents: ConversationActivityEvent[] = [];
  const activity = {
    record: vi.fn(async (event: ConversationActivityEvent) => {
      steps.push(`activity:${event.kind}`);
      activityEvents.push(event);
    }),
  };
  const lockedConversations = {
    lockForUpdate: vi.fn(async (id: string, inWorkspace: string) => {
      steps.push("lock_conversation");
      return id === conversationId && inWorkspace === workspaceId;
    }),
  };
  const lockedOwnership = {
    loadForUpdate: vi.fn(async (id: string) => {
      steps.push("lock_ownership");
      return ownership.loadForUpdate(id);
    }),
  };
  const channelFor = vi.fn((ref: string) =>
    (options.channel !== "unregistered" && ref.startsWith("email_mailbox:") ? channelScope : null));
  const audit = { record: vi.fn(async () => undefined) };
  const publisher = { enqueue: vi.fn(() => ({ accepted: true as const, coalesced: false })) };
  const publicConversationEventBus = { publish: vi.fn() };
  const metrics = { incrementCounter: vi.fn() };
  const replies = new OperatorReplyService({
    auditService: audit,
    publicConversationEventBus,
    customerReplyDelivery,
    publisher,
  });
  const operatorIdentities = {
    resolve: vi.fn(async (input: { userId: string }) => ({
      userId: input.userId,
      teammateLabel: "Dana Scully",
      replySignature: "Dana",
    })),
  };
  const service = new HeldReplyService({
    conversations: {
      findByIdAndWorkspaceId: vi.fn(async (id: string, inWorkspace: string) =>
        (id === conversationId && inWorkspace === workspaceId ? conversation : null)),
    },
    writes: {
      run: (work) => work({
        conversations: lockedConversations,
        ownership: lockedOwnership,
        channelFor,
        heldReplies,
        reply: replyScope,
        drafts,
        activity,
      }),
    },
    reads: heldReplies,
    operatorIdentities,
    customerReplyDelivery,
    replies,
    audit,
    publisher,
    metrics,
  });
  return {
    service, steps, heldReplies, ownership, takeOver, channelScope, channelState, channelFor, outbox, route, customerReplyDelivery,
    replyScope, drafts, messages, activityEvents, audit, publisher, publicConversationEventBus, metrics,
  };
};

const auditCalls = (audit: { record: ReturnType<typeof vi.fn> }) =>
  audit.record.mock.calls.map(([event]) => event as { eventType: string; accountId: string | null; metadata: Record<string, unknown> });

describe("HeldReplyService", () => {
  describe("hold", () => {
    it("holds a current review result as pending, under the conversation, ownership and policy locks", async () => {
      const { service, steps, heldReplies, channelScope, audit, publisher, metrics } = createService();

      const held = await service.hold(holdInput());

      expect(held).toEqual({ heldReplyId: "held-1", state: "pending", duplicate: false });
      expect(steps).toEqual(["lock_conversation", "lock_ownership", "lock_policy"]);
      expect(channelScope.lockPolicy).toHaveBeenCalledWith(policyRef);
      expect(heldReplies.rows.get("held-1")).toMatchObject({
        state: "pending",
        agentId: "agent-1",
        answersMessageId: inboundId,
        ownershipVersion: 0,
        policy: { ref: policyRef, version: 5 },
        draft: { text: draftText, presentation: draftPresentation },
      });
      expect(auditCalls(audit)).toEqual([{
        accountId: null,
        workspaceId,
        eventType: "hitl.held_reply",
        eventStatus: "success",
        metadata: {
          action: "created",
          actorUserId: null,
          heldReplyId: "held-1",
          conversationId,
          holdReason: "draft_mode",
          grounding: "grounded",
          coverage: "answered",
          handoffRequested: false,
        },
      }]);
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(draftText);
      expect(publisher.enqueue).toHaveBeenCalledWith(workspaceId, ["hitl.decision_created"]);
      expect(metrics.incrementCounter).toHaveBeenCalledWith("held_replies_total", expect.objectContaining({
        labels: { transition: "created" },
      }));
    });

    it("is idempotent on the review ref: holding the same review again finds the first", async () => {
      const { service, heldReplies, audit } = createService();

      const first = await service.hold(holdInput());
      const again = await service.hold(holdInput({ draft: { text: "A different draft", presentation: {} } }));

      expect(again).toEqual({ heldReplyId: first.heldReplyId, state: "pending", duplicate: true });
      expect(heldReplies.rows.size).toBe(1);
      expect(heldReplies.rows.get(first.heldReplyId)?.draft.text).toBe(draftText);
      expect(audit.record).toHaveBeenCalledTimes(1);
    });

    it("is born superseded when a newer customer message arrived after the one it answers", async () => {
      const { service, heldReplies, audit, publisher } = createService();
      heldReplies.latestCustomerMessage.set(conversationId, "message-inbound-2");

      const held = await service.hold(holdInput());

      expect(held).toEqual({ heldReplyId: "held-1", state: "superseded", duplicate: false });
      expect(heldReplies.rows.get("held-1")).toMatchObject({ supersededReason: "newer_inbound" });
      expect(auditCalls(audit).map((event) => event.metadata)).toEqual([
        { action: "superseded", actorUserId: null, heldReplyId: "held-1", conversationId, reason: "newer_inbound" },
      ]);
      expect(publisher.enqueue).not.toHaveBeenCalled();
    });

    it("is born superseded when the ownership moved since the review ran", async () => {
      const { service, heldReplies, ownership } = createService();
      await ownership.requestHandoff({ conversationId, workspaceId, reason: "review_unavailable" });

      const held = await service.hold(holdInput({ ownershipVersion: 0 }));

      expect(held.state).toBe("superseded");
      expect(heldReplies.rows.get(held.heldReplyId)?.supersededReason).toBe("takeover");
    });

    it("is born superseded when the bound policy changed, or no channel can vouch for it", async () => {
      const changed = createService({ lockedPolicyVersion: 6 });
      expect((await changed.service.hold(holdInput())).state).toBe("superseded");
      expect(changed.heldReplies.rows.get("held-1")?.supersededReason).toBe("policy_changed");

      const removed = createService({ lockedPolicyVersion: null });
      expect((await removed.service.hold(holdInput())).state).toBe("superseded");

      const unclaimed = createService({ channel: "unregistered" });
      expect((await unclaimed.service.hold(holdInput())).state).toBe("superseded");
    });

    it("binds no policy when the producer has none, and checks only ownership and the inbound", async () => {
      const { service, steps } = createService();

      const held = await service.hold(holdInput({ policy: null }));

      expect(held.state).toBe("pending");
      expect(steps).toEqual(["lock_conversation", "lock_ownership"]);
    });

    it("finds a held reply by its review ref", async () => {
      const { service } = createService();
      const held = await service.hold(holdInput());

      expect(await service.findByReviewRef(conversationId, `email:${conversationId}:1`))
        .toEqual({ heldReplyId: held.heldReplyId, state: "pending" });
      expect(await service.findByReviewRef(conversationId, `email:${conversationId}:2`)).toBeNull();
    });
  });

  describe("queueAuto", () => {
    const queueInput = (overrides: Partial<HoldReplyInput> = {}) => {
      const { holdReason: _holdReason, ...input } = holdInput(overrides);
      return input;
    };

    it("queues a current result to publish as queued_auto, reserving a send and enqueueing it under the locks", async () => {
      const { service, steps, heldReplies, channelScope, outbox, drafts, publisher, metrics } = createService();

      const queued = await service.queueAuto(queueInput());

      expect(queued).toEqual({ ok: true, heldReplyId: "held-1", duplicate: false });
      expect(steps).toEqual([
        "lock_conversation",
        "lock_ownership",
        "lock_policy",
        "reserve_auto_send",
        "enqueue:email:send:held:held-1",
      ]);
      expect(channelScope.reserveAutoSend).toHaveBeenCalledWith(conversationId);
      expect(channelScope.enqueueAutoSend).toHaveBeenCalledWith(
        { id: "held-1", conversationId, policyRef, policyVersion: 5, ownershipVersion: 0 },
        outbox,
      );
      const row = heldReplies.rows.get("held-1");
      expect(row).toMatchObject({ state: "queued_auto", releaseKind: null, draft: { text: draftText, presentation: draftPresentation } });
      expect(isHeldReplyAttentionOpen(row!)).toBe(false);
      // Held content stays out of message rows until the send is authorized at dispatch.
      expect(drafts.writeAgentMessage).not.toHaveBeenCalled();
      expect(publisher.enqueue).not.toHaveBeenCalled();
      expect(metrics.incrementCounter).toHaveBeenCalledWith("held_replies_total", expect.objectContaining({
        labels: { transition: "queued_auto" },
      }));
    });

    it("is idempotent on the review ref: queueing the same review again finds the first and reserves nothing", async () => {
      const { service, heldReplies, channelScope, outbox } = createService();

      const first = await service.queueAuto(queueInput());
      const again = await service.queueAuto(queueInput({ draft: { text: "A different draft", presentation: {} } }));

      expect(again).toEqual({ ok: true, heldReplyId: first.ok ? first.heldReplyId : "", duplicate: true });
      expect(heldReplies.rows.size).toBe(1);
      expect(channelScope.reserveAutoSend).toHaveBeenCalledTimes(1);
      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    });

    it("refuses with ownership_changed once the ownership moved since the review ran, recording nothing", async () => {
      const { service, heldReplies, ownership, channelScope } = createService();
      await ownership.requestHandoff({ conversationId, workspaceId, reason: "review_unavailable" });

      expect(await service.queueAuto(queueInput({ ownershipVersion: 0 }))).toEqual({ ok: false, refused: "ownership_changed" });
      expect(heldReplies.rows.size).toBe(0);
      expect(channelScope.reserveAutoSend).not.toHaveBeenCalled();
    });

    it("refuses with policy_changed when the policy moved on, or no channel policy vouches for the send", async () => {
      for (const setup of [
        { options: { lockedPolicyVersion: 6 }, input: {} },
        { options: { lockedPolicyVersion: null }, input: {} },
        { options: { channel: "unregistered" as const }, input: {} },
        { options: {}, input: { policy: null } },
      ]) {
        const { service, heldReplies, channelScope, outbox } = createService(setup.options);

        expect(await service.queueAuto(queueInput(setup.input))).toEqual({ ok: false, refused: "policy_changed" });
        expect(heldReplies.rows.size).toBe(0);
        expect(channelScope.reserveAutoSend).not.toHaveBeenCalled();
        expect(outbox.enqueue).not.toHaveBeenCalled();
      }
    });

    it("refuses with superseded when a newer customer message arrived after the one it answers", async () => {
      const { service, heldReplies, channelScope } = createService();
      heldReplies.latestCustomerMessage.set(conversationId, "message-inbound-2");

      expect(await service.queueAuto(queueInput())).toEqual({ ok: false, refused: "superseded" });
      expect(heldReplies.rows.size).toBe(0);
      expect(channelScope.reserveAutoSend).not.toHaveBeenCalled();
    });

    it("refuses with send_budget when the channel reserves no send, recording and enqueueing nothing", async () => {
      const { service, heldReplies, channelState, outbox } = createService();
      channelState.sendBudgetLeft = false;

      expect(await service.queueAuto(queueInput())).toEqual({ ok: false, refused: "send_budget" });
      expect(heldReplies.rows.size).toBe(0);
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });
  });

  describe("materializeAuto", () => {
    const queued = async (harness: ReturnType<typeof createService>): Promise<string> => {
      const { holdReason: _holdReason, ...input } = holdInput();
      const result = await harness.service.queueAuto(input);
      if (!result.ok) throw new Error(`queueAuto refused: ${result.refused}`);
      harness.steps.length = 0;
      harness.outbox.enqueue.mockClear();
      harness.metrics.incrementCounter.mockClear();
      return result.heldReplyId;
    };

    it("writes the agent message from the draft presentation, releases it as auto and records the send, in one unit", async () => {
      const harness = createService();
      const { service, steps, heldReplies, drafts, replyScope, channelScope, outbox, audit, publisher, metrics } = harness;
      const heldReplyId = await queued(harness);

      const materialized = await service.materializeAuto(heldReplyId);

      expect(materialized).toEqual({ ok: true, messageId: "message-out-1" });
      // Lock order: the conversation, its ownership, the producing channel's policy, then the conditional update.
      expect(steps).toEqual([
        "lock_conversation",
        "lock_ownership",
        "lock_policy",
        "authorize_auto_dispatch",
        "materialize_held_reply",
        "write_message",
        "record_materialized",
      ]);
      const authority = { id: heldReplyId, conversationId, policyRef, policyVersion: 5, ownershipVersion: 0 };
      expect(channelScope.authorizeAutoDispatch).toHaveBeenCalledWith(authority);
      expect(drafts.writeAgentMessage).toHaveBeenCalledWith({
        workspaceId,
        conversationId,
        agentId: "agent-1",
        draft: { text: draftText, presentation: draftPresentation },
      });
      expect(replyScope.conversations.touch).toHaveBeenCalledWith(conversationId, workspaceId);
      expect(channelScope.recordMaterialized).toHaveBeenCalledWith(authority, "message-out-1");
      // The send was enqueued when it was queued; materializing queues nothing more.
      expect(outbox.enqueue).not.toHaveBeenCalled();
      const row = heldReplies.rows.get(heldReplyId);
      expect(row).toMatchObject({ state: "released", releaseKind: "auto", releasedMessageId: "message-out-1", attentionClearedReason: "released" });
      expect(auditCalls(audit).map((event) => event.metadata)).toEqual([
        { action: "auto_released", actorUserId: null, heldReplyId, conversationId, messageId: "message-out-1" },
      ]);
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(draftText);
      expect(publisher.enqueue).toHaveBeenCalledWith(workspaceId, ["conversation.turn_committed"]);
      expect(metrics.incrementCounter).toHaveBeenCalledWith("held_replies_total", expect.objectContaining({
        labels: { transition: "auto_released" },
      }));
    });

    it("returns a send the channel no longer authorizes to pending with authority_changed, writing no message", async () => {
      const harness = createService();
      const { service, heldReplies, drafts, channelScope, channelState, audit, publisher, messages } = harness;
      const heldReplyId = await queued(harness);
      channelState.dispatch = { authorized: false, code: "mode_changed" };

      expect(await service.materializeAuto(heldReplyId)).toEqual({ ok: false, reason: "returned_to_pending" });

      const row = heldReplies.rows.get(heldReplyId);
      expect(row).toMatchObject({ state: "pending", releaseKind: null, holdReason: "authority_changed", releasedMessageId: null, decidedAt: null });
      expect(isHeldReplyAttentionOpen(row!)).toBe(true);
      expect(drafts.writeAgentMessage).not.toHaveBeenCalled();
      expect(messages).toEqual([]);
      expect(channelScope.recordMaterialized).not.toHaveBeenCalled();
      expect(auditCalls(audit).map((event) => event.metadata)).toEqual([{
        action: "returned_to_pending",
        actorUserId: null,
        heldReplyId,
        conversationId,
        holdReason: "authority_changed",
        code: "mode_changed",
      }]);
      expect(publisher.enqueue).toHaveBeenCalledWith(workspaceId, ["hitl.decision_created"]);
    });

    it("returns it to pending without asking the channel once its ownership or policy moved on", async () => {
      const moved = createService();
      const movedId = await queued(moved);
      await moved.ownership.requestHandoff({ conversationId, workspaceId, reason: "review_unavailable" });

      expect(await moved.service.materializeAuto(movedId)).toEqual({ ok: false, reason: "returned_to_pending" });
      expect(moved.channelScope.authorizeAutoDispatch).not.toHaveBeenCalled();
      expect(moved.messages).toEqual([]);

      const changed = createService();
      const changedId = await queued(changed);
      changed.channelState.lockedPolicyVersion = 6;

      expect(await changed.service.materializeAuto(changedId)).toEqual({ ok: false, reason: "returned_to_pending" });
      expect(changed.channelScope.authorizeAutoDispatch).not.toHaveBeenCalled();
      expect(changed.heldReplies.rows.get(changedId)).toMatchObject({ state: "pending", holdReason: "authority_changed" });
    });

    it("does nothing for a send superseded while queued, already materialized, or unknown", async () => {
      const harness = createService();
      const { service, heldReplies, channelScope, drafts, audit } = harness;
      const heldReplyId = await queued(harness);
      const row = heldReplies.rows.get(heldReplyId)!;
      heldReplies.rows.set(heldReplyId, { ...row, state: "superseded", supersededReason: "takeover" });

      expect(await service.materializeAuto(heldReplyId)).toEqual({ ok: false, reason: "not_queued" });
      expect(await service.materializeAuto("held-unknown")).toEqual({ ok: false, reason: "not_queued" });
      expect(channelScope.authorizeAutoDispatch).not.toHaveBeenCalled();
      expect(drafts.writeAgentMessage).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();

      const sent = createService();
      const sentId = await queued(sent);
      await sent.service.materializeAuto(sentId);
      expect(await sent.service.materializeAuto(sentId)).toEqual({ ok: false, reason: "not_queued" });
      expect(sent.messages).toHaveLength(1);
    });

    it("writes nothing when a change superseded the queued send while it waited for the policy lock", async () => {
      const harness = createService();
      const { service, heldReplies, drafts, channelScope } = harness;
      const heldReplyId = await queued(harness);
      heldReplies.loseNextMaterializeTo = "superseded";

      expect(await service.materializeAuto(heldReplyId)).toEqual({ ok: false, reason: "not_queued" });
      expect(heldReplies.rows.get(heldReplyId)?.state).toBe("superseded");
      expect(drafts.writeAgentMessage).not.toHaveBeenCalled();
      expect(channelScope.recordMaterialized).not.toHaveBeenCalled();
    });
  });

  describe("returnAbandonedAuto", () => {
    const queued = async (harness: ReturnType<typeof createService>): Promise<string> => {
      const { holdReason: _holdReason, ...input } = holdInput();
      const result = await harness.service.queueAuto(input);
      if (!result.ok) throw new Error(`queueAuto refused: ${result.refused}`);
      harness.steps.length = 0;
      harness.metrics.incrementCounter.mockClear();
      return result.heldReplyId;
    };

    it("returns a send whose dispatch was abandoned to pending with authority_changed, under the locks, without authorizing it", async () => {
      const harness = createService();
      const { service, steps, heldReplies, drafts, channelScope, audit, publisher, metrics, messages } = harness;
      const heldReplyId = await queued(harness);

      expect(await service.returnAbandonedAuto(heldReplyId)).toBe(true);

      expect(steps).toEqual(["lock_conversation", "lock_ownership", "materialize_held_reply"]);
      const row = heldReplies.rows.get(heldReplyId);
      expect(row).toMatchObject({ state: "pending", releaseKind: null, holdReason: "authority_changed", releasedMessageId: null });
      expect(isHeldReplyAttentionOpen(row!)).toBe(true);
      expect(channelScope.authorizeAutoDispatch).not.toHaveBeenCalled();
      expect(drafts.writeAgentMessage).not.toHaveBeenCalled();
      expect(messages).toEqual([]);
      expect(auditCalls(audit).map((event) => event.metadata)).toEqual([{
        action: "returned_to_pending",
        actorUserId: null,
        heldReplyId,
        conversationId,
        holdReason: "authority_changed",
        code: "dispatch_abandoned",
      }]);
      expect(publisher.enqueue).toHaveBeenCalledWith(workspaceId, ["hitl.decision_created"]);
      expect(metrics.incrementCounter).toHaveBeenCalledWith("held_replies_total", expect.objectContaining({
        labels: { transition: "returned_to_pending" },
      }));
    });

    it("changes nothing for a send no longer queued, or unknown", async () => {
      const harness = createService();
      const { service, heldReplies, audit } = harness;
      const heldReplyId = await queued(harness);
      const row = heldReplies.rows.get(heldReplyId)!;
      heldReplies.rows.set(heldReplyId, { ...row, state: "superseded", supersededReason: "takeover" });

      expect(await service.returnAbandonedAuto(heldReplyId)).toBe(false);
      expect(await service.returnAbandonedAuto("held-unknown")).toBe(false);
      expect(heldReplies.rows.get(heldReplyId)?.state).toBe("superseded");
      expect(audit.record).not.toHaveBeenCalled();

      const sent = createService();
      const sentId = await queued(sent);
      await sent.service.materializeAuto(sentId);
      expect(await sent.service.returnAbandonedAuto(sentId)).toBe(false);
      expect(sent.heldReplies.rows.get(sentId)?.state).toBe("released");
    });
  });

  describe("release", () => {
    it("releases an unchanged draft as the agent's message, written from the draft presentation", async () => {
      const {
        service, heldReplies, drafts, replyScope, outbox, route, channelScope, activityEvents, audit, publicConversationEventBus,
      } = createService();
      const { heldReplyId } = await service.hold(holdInput());
      audit.record.mockClear();

      const released = await service.release(dana, { conversationId, heldReplyId, editedText: null });

      expect(released).toMatchObject({
        ok: true,
        messageId: "message-out-1",
        heldReply: {
          id: heldReplyId,
          state: "released",
          draftText,
          editedText: null,
          releaserUserId: "user-dana",
          editorUserId: null,
          releasedMessageId: "message-out-1",
          attentionOpen: false,
        },
      });
      expect(drafts.writeAgentMessage).toHaveBeenCalledWith({
        workspaceId,
        conversationId,
        agentId: "agent-1",
        draft: { text: draftText, presentation: draftPresentation },
      });
      expect(replyScope.messages.create).not.toHaveBeenCalled();
      expect(replyScope.conversations.touch).toHaveBeenCalledWith(conversationId, workspaceId);
      // The producing channel queues it as its release of the held reply, under the bound authority.
      expect(channelScope.enqueueRelease).toHaveBeenCalledWith(
        { id: heldReplyId, conversationId, policyRef, policyVersion: 5, ownershipVersion: 0 },
        "message-out-1",
        outbox,
      );
      expect(route.enqueue).not.toHaveBeenCalled();
      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
      expect(heldReplies.rows.get(heldReplyId)).toMatchObject({ releaseKind: "operator", releasedMessageId: "message-out-1" });
      expect(activityEvents).toEqual([{
        kind: "held_reply_released",
        conversationId,
        workspaceId,
        actorUserId: "user-dana",
        detail: { heldReplyId, messageId: "message-out-1", edited: false },
      }]);
      expect(auditCalls(audit)).toEqual([expect.objectContaining({
        accountId,
        eventType: "hitl.held_reply",
        metadata: {
          action: "released",
          actorUserId: "user-dana",
          heldReplyId,
          conversationId,
          releaserUserId: "user-dana",
          messageId: "message-out-1",
        },
      })]);
      expect(publicConversationEventBus.publish).toHaveBeenCalledWith(expect.objectContaining({
        type: "message.created",
        messageId: "message-out-1",
      }));
    });

    it("releases an edit as the teammate's own message and keeps the original draft", async () => {
      const { service, heldReplies, drafts, replyScope, outbox, route, channelScope, messages, activityEvents, audit } = createService();
      const { heldReplyId } = await service.hold(holdInput());
      audit.record.mockClear();

      const released = await service.release(dana, { conversationId, heldReplyId, editedText: "Refund issued Monday. — Dana" });

      expect(released).toMatchObject({
        ok: true,
        heldReply: {
          state: "edited",
          draftText,
          editedText: "Refund issued Monday. — Dana",
          editorUserId: "user-dana",
          releaserUserId: "user-dana",
        },
      });
      expect(drafts.writeAgentMessage).not.toHaveBeenCalled();
      expect(replyScope.messages.create).toHaveBeenCalledWith(expect.objectContaining({
        content: "Refund issued Monday. — Dana",
        role: "assistant",
        source: "human_agent",
        operatorAccountId: accountId,
        operatorUserId: "user-dana",
        operatorDisplayName: "Dana",
      }));
      expect(messages.map((message) => message.content)).toEqual(["Refund issued Monday. — Dana"]);
      expect(channelScope.enqueueRelease).toHaveBeenCalledWith(expect.objectContaining({ id: heldReplyId }), "message-out-1", outbox);
      expect(route.enqueue).not.toHaveBeenCalled();
      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
      expect(heldReplies.rows.get(heldReplyId)?.draft.text).toBe(draftText);
      expect(activityEvents).toEqual([expect.objectContaining({
        kind: "held_reply_released",
        detail: { heldReplyId, messageId: "message-out-1", edited: true },
      })]);
      expect(auditCalls(audit).map((event) => event.metadata)).toEqual([{
        action: "edited_released",
        actorUserId: "user-dana",
        heldReplyId,
        conversationId,
        editorUserId: "user-dana",
        releaserUserId: "user-dana",
        messageId: "message-out-1",
      }]);
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain("Refund issued");
    });

    it("locks the conversation, then the ownership, then the policy, before the conditional update and the writes", async () => {
      const { service, steps } = createService();
      const { heldReplyId } = await service.hold(holdInput());
      steps.length = 0;

      await service.release(dana, { conversationId, heldReplyId, editedText: null });

      expect(steps).toEqual([
        "lock_conversation",
        "lock_ownership",
        "lock_policy",
        "release_held_reply",
        "write_message",
        "enqueue:email:send:msg:message-out-1",
        "activity:held_reply_released",
      ]);
    });

    it("delivers a draft no channel bound the way any reply on the conversation goes", async () => {
      const { service, route, channelScope, outbox } = createService();
      const { heldReplyId } = await service.hold(holdInput({ policy: null }));

      await service.release(dana, { conversationId, heldReplyId, editedText: null });

      expect(route.enqueue).toHaveBeenCalledWith(outbox, { id: "message-out-1", content: draftText });
      expect(channelScope.enqueueRelease).not.toHaveBeenCalled();
    });

    it("leaves the conversation's ownership as it was, edited or not", async () => {
      for (const editedText of [null, "Edited"]) {
        const { service, ownership, takeOver } = createService();
        const { heldReplyId } = await service.hold(holdInput());

        await service.release(dana, { conversationId, heldReplyId, editedText });

        expect(takeOver).not.toHaveBeenCalled();
        expect(await ownership.load(conversationId)).toBeNull();
      }
    });

    it("compares the bound policy version with the one the channel locked", async () => {
      const { service, heldReplies, channelScope, messages } = createService({ lockedPolicyVersion: 6 });
      const held = heldReplies.seed({ policy: { ref: policyRef, version: 5 } });

      const refused = await service.release(dana, { conversationId, heldReplyId: held.id, editedText: null });

      expect(channelScope.lockPolicy).toHaveBeenCalledWith(policyRef);
      expect(refused).toMatchObject({ ok: false, refusal: "policy_changed", current: { id: held.id, state: "pending" } });
      expect(heldReplies.rows.get(held.id)?.state).toBe("pending");
      expect(messages).toEqual([]);
    });

    it("refuses with the held reply as it is once the policy lock is held, not as it was read before", async () => {
      const { service, heldReplies, channelScope, messages } = createService({ lockedPolicyVersion: 6 });
      const held = heldReplies.seed({ policy: { ref: policyRef, version: 5 } });
      // The policy change the lock waited out superseded the draft before it committed.
      vi.mocked(channelScope.lockPolicy).mockImplementationOnce(async () => {
        heldReplies.rows.set(held.id, {
          ...held,
          state: "superseded",
          supersededReason: "policy_changed",
          attentionClearedAt: new Date(),
          attentionClearedReason: "superseded",
          decidedAt: new Date(),
        });
        return { version: 6 };
      });

      const refused = await service.release(dana, { conversationId, heldReplyId: held.id, editedText: null });

      expect(refused).toMatchObject({
        ok: false,
        refusal: "policy_changed",
        current: { id: held.id, state: "superseded", supersededReason: "policy_changed", attentionOpen: false },
      });
      expect(messages).toEqual([]);
    });

    it("refuses a draft that is no longer pending, with its current state", async () => {
      const { service, heldReplies, messages } = createService();
      const discarded = heldReplies.seed({ state: "discarded", discardedByUserId: "user-fox", decidedAt: new Date() });

      expect(await service.release(dana, { conversationId, heldReplyId: discarded.id, editedText: null }))
        .toMatchObject({ ok: false, refusal: "not_pending", current: { id: discarded.id, state: "discarded", attentionOpen: true } });
      expect(messages).toEqual([]);
    });

    it("gives the loser of a concurrent release nothing but the winner's state", async () => {
      const { service, heldReplies, messages, activityEvents, outbox, audit } = createService();
      const { heldReplyId } = await service.hold(holdInput());
      audit.record.mockClear();
      heldReplies.loseNextReleaseTo = "released";

      const lost = await service.release(dana, { conversationId, heldReplyId, editedText: null });

      expect(lost).toMatchObject({ ok: false, refusal: "not_pending", current: { state: "released", releaserUserId: "user-fox" } });
      expect(messages).toEqual([]);
      expect(outbox.enqueue).not.toHaveBeenCalled();
      expect(activityEvents).toEqual([]);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("refuses once the ownership moved since the review", async () => {
      const { service, ownership, messages } = createService();
      const { heldReplyId } = await service.hold(holdInput());
      await ownership.requestHandoff({ conversationId, workspaceId, reason: "review_unavailable" });

      expect(await service.release(dana, { conversationId, heldReplyId, editedText: null }))
        .toMatchObject({ ok: false, refusal: "ownership_changed", current: { state: "pending" } });
      expect(messages).toEqual([]);
    });

    it("refuses when the channel is not ready: no channel claims the policy, the policy is gone, or there is no route", async () => {
      const unclaimed = createService({ channel: "unregistered" });
      const unclaimedDraft = unclaimed.heldReplies.seed({});
      expect(await unclaimed.service.release(dana, { conversationId, heldReplyId: unclaimedDraft.id, editedText: null }))
        .toMatchObject({ ok: false, refusal: "channel_not_ready" });

      const gone = createService({ lockedPolicyVersion: null });
      const goneDraft = gone.heldReplies.seed({});
      expect(await gone.service.release(dana, { conversationId, heldReplyId: goneDraft.id, editedText: null }))
        .toMatchObject({ ok: false, refusal: "channel_not_ready" });

      const unrouted = createService({ route: "none" });
      const unroutedDraft = unrouted.heldReplies.seed({});
      expect(await unrouted.service.release(dana, { conversationId, heldReplyId: unroutedDraft.id, editedText: null }))
        .toMatchObject({ ok: false, refusal: "channel_not_ready" });
      expect([...unclaimed.messages, ...gone.messages, ...unrouted.messages]).toEqual([]);
    });

    it("answers not found for a held reply outside the conversation, or a conversation outside the workspace", async () => {
      const { service } = createService();

      await expect(service.release(dana, { conversationId, heldReplyId: "held-missing", editedText: null }))
        .rejects.toMatchObject({ statusCode: 404 });
      await expect(service.release({ ...dana, workspaceId: "workspace-2" }, { conversationId, heldReplyId: "held-1", editedText: null }))
        .rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("discard", () => {
    it("discards a pending draft and keeps the conversation's attention open", async () => {
      const { service, activityEvents, audit, messages } = createService();
      const { heldReplyId } = await service.hold(holdInput());
      audit.record.mockClear();

      const discarded = await service.discard(dana, { conversationId, heldReplyId });

      expect(discarded).toMatchObject({
        ok: true,
        heldReply: { id: heldReplyId, state: "discarded", discardedByUserId: "user-dana", attentionOpen: true },
      });
      expect(await service.current(dana, conversationId)).toMatchObject({ heldReply: { id: heldReplyId, attentionOpen: true } });
      expect((await service.list(dana, { attention: "open", limit: 10 })).items.map((item) => item.id)).toEqual([heldReplyId]);
      expect(activityEvents).toEqual([{
        kind: "held_reply_discarded",
        conversationId,
        workspaceId,
        actorUserId: "user-dana",
        detail: { heldReplyId },
      }]);
      expect(auditCalls(audit).map((event) => event.metadata)).toEqual([
        { action: "discarded", actorUserId: "user-dana", heldReplyId, conversationId, userId: "user-dana" },
      ]);
      expect(messages).toEqual([]);
    });

    it("refuses a draft that is no longer pending, with its current state", async () => {
      const { service, heldReplies, activityEvents } = createService();
      const released = heldReplies.seed({
        state: "released", releaseKind: "operator", releaserUserId: "user-fox", attentionClearedAt: new Date(), decidedAt: new Date(),
      });

      expect(await service.discard(dana, { conversationId, heldReplyId: released.id }))
        .toMatchObject({ ok: false, refusal: "not_pending", current: { id: released.id, state: "released" } });
      expect(activityEvents).toEqual([]);
      await expect(service.discard(dana, { conversationId, heldReplyId: "held-missing" })).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("list and current", () => {
    it("lists the drafts waiting for a teammate, leaving queued automatic sends out unless all are asked for", async () => {
      const { service, heldReplies } = createService();
      const pending = heldReplies.seed({ state: "pending" });
      const queued = heldReplies.seed({ state: "queued_auto", conversationId: "conversation-2" });
      const superseded = heldReplies.seed({
        state: "superseded", supersededReason: "newer_inbound", attentionClearedAt: new Date(), decidedAt: new Date(),
      });

      const open = await service.list(dana, { attention: "open", limit: 10 });
      const all = await service.list(dana, { attention: "all", limit: 10 });

      expect(open.items.map((item) => item.id)).toEqual([pending.id]);
      expect(all.items.map((item) => item.id)).toEqual([superseded.id, queued.id, pending.id]);
      expect(all.items.find((item) => item.id === queued.id)).toMatchObject({ state: "queued_auto", attentionOpen: false });
    });

    it("pages newest first with an opaque cursor", async () => {
      const { service, heldReplies } = createService();
      const ids = [1, 2, 3].map((n) => heldReplies.seed({ conversationId: `conversation-${n}` }).id);

      const first = await service.list(dana, { attention: "open", limit: 2 });
      const second = await service.list(dana, { attention: "open", limit: 2, cursor: first.nextCursor! });

      expect(first.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(second).toMatchObject({ items: [{ id: ids[0] }], nextCursor: null });
    });

    it("presents the facts operators judge a draft by", async () => {
      const { service } = createService();
      await service.hold(holdInput({
        facts: {
          outcome: "handoff",
          grounding: "ungrounded",
          coverage: "partial",
          handoff: { requested: true, reason: "billing_dispute" },
          suppressedEffects: [{ skillName: "issue_refund" }],
          citationCount: 0,
        },
      }));

      expect(await service.current(dana, conversationId)).toEqual({
        heldReply: expect.objectContaining({
          holdReason: "draft_mode",
          facts: {
            outcome: "handoff",
            grounding: "ungrounded",
            coverage: "partial",
            handoff: { requested: true, reason: "billing_dispute" },
          },
          dependsOnSuppressedAction: true,
          suppressedEffects: [{ skillName: "issue_refund" }],
          answersMessageId: inboundId,
          attentionOpen: true,
        }),
      });
    });

    it("returns the conversation's current held reply as an object root", async () => {
      const { service } = createService();

      expect(await service.current(dana, conversationId)).toEqual({ heldReply: null });
      const { heldReplyId } = await service.hold(holdInput());
      expect(await service.current(dana, conversationId)).toEqual({ heldReply: expect.objectContaining({ id: heldReplyId }) });
      await expect(service.current({ ...dana, workspaceId: "workspace-2" }, conversationId)).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});
