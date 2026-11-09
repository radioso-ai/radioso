import { createHash, randomBytes } from "node:crypto";

import type { AgentConverseService, AgentConverseTurnResult } from "../../chat/contracts/index.js";
import type {
  A2aMessageReceiptStore,
  A2aReceiptResult,
  A2aTaskChanges,
  A2aTaskRecord,
  A2aTaskStore,
  A2aTaskWrite,
  A2aTranscriptPage,
  A2aTranscriptPort,
  A2aTurnEnvelope,
} from "../contracts/ports.js";
import { a2aError, radiosoError } from "../domain/a2aErrors.js";
import type { SendMessageInput } from "../domain/requestParams.js";
import {
  decideTaskAfterTurn,
  isOpenTaskState,
  marksHumanStretch,
  type TurnTaskDecision,
  type TurnTaskFacts,
} from "../domain/taskState.js";
import { renderAgentMessage, type WireMessage, type WireTask } from "../domain/taskWire.js";
import { authoredMessages, humanRepliesAfter, unseenHumanMessages, type AuthoredMessage } from "../domain/turnMessages.js";
import type { A2aContextAdmission } from "./a2aAccess.js";
import type { A2aObserver } from "./a2aObserver.js";
import type { A2aTaskView } from "./a2aTaskView.js";
import { readToEnd } from "./transcriptReads.js";

export type SendMessageResult = { message: WireMessage } | { task: WireTask };

/** The latest messages a turn reads, with no task open, to find a person's messages the caller has not seen. */
const LATEST_PAGE_LIMIT = 50;

/** A claim older than this is a send that died with its process, not one still running. */
const RECEIPT_STALE_AFTER_MS = 10 * 60 * 1_000;

/** Compare-and-set attempts before a turn's settlement gives up against concurrent writers. */
const SETTLE_ATTEMPTS = 3;

/** 128 random bits, independent of any routine or conversation id. */
const newTaskId = (): string => randomBytes(16).toString("base64url");

/** Names one send's receipt claim, so a send whose claim was taken over completes and releases nothing. */
const newClaimToken = (): string => randomBytes(16).toString("base64url");

/** The caller's message id as a receipt keeps it: a digest, bounded and never the id itself. */
const messageKeyFor = (messageId: string): string => createHash("sha256").update(messageId).digest("base64url");

const envelopeOf = (turn: AgentConverseTurnResult): A2aTurnEnvelope => ({
  answerCoverage: turn.reply.answerCoverage,
  ownership: turn.reply.ownership,
  ...(turn.reply.routine ? { routine: turn.reply.routine } : {}),
  ...(turn.reply.invocation ? { invocation: turn.reply.invocation } : {}),
  citations: turn.reply.answer.citations,
});

/**
 * What a task records of a turn. A routine that yielded to an off-topic message reports nothing, yet
 * its run, and what it waits for, are as the open task last recorded them, so that report stays.
 */
const taskEnvelopeOf = (turn: AgentConverseTurnResult, open: A2aTaskRecord | null): A2aTurnEnvelope => {
  const envelope = envelopeOf(turn);
  const yieldedRun = !envelope.routine && turn.activeRoutineExecutionId !== null && open?.routineExecutionId === turn.activeRoutineExecutionId;
  return yieldedRun && open.envelope?.routine ? { ...envelope, routine: open.envelope.routine } : envelope;
};

/** Where the conversation stood before the turn, as far as the caller had been shown it. */
interface BeforeTurn {
  cursor: string | null;
  /** With no task open: what a person wrote after the caller's previous message. */
  unseenHumans: AuthoredMessage[];
}

/**
 * The conversation after the turn, read past the cursor it started from: where the caller's view
 * now ends, and what a person wrote after the turn's own message while it ran.
 */
interface AfterTurn {
  page: A2aTranscriptPage;
  humanReplies: AuthoredMessage[];
}

/**
 * `SendMessage`: one converse turn, and the task bookkeeping around it (FR-033, FR-034, FR-038).
 * It returns when the turn finishes. A plain answer with nothing pending is a `Message` and leaves
 * no record; anything else is the task the turn ended in, opened, continued or replaced by the
 * precedence table. Task writes compare and set, so a concurrent read computed from an older
 * snapshot never overwrites what this turn decided: on a conflict the turn re-decides against the
 * task as it now stands.
 */
export class A2aSendMessageService {
  private readonly clock: () => Date;

  constructor(
    private readonly dependencies: {
      converse: Pick<AgentConverseService, "askAgent">;
      tasks: A2aTaskStore;
      receipts: A2aMessageReceiptStore;
      transcript: A2aTranscriptPort;
      view: A2aTaskView;
      observer: A2aObserver;
      clock?: () => Date;
    },
  ) {
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async send(
    admission: A2aContextAdmission,
    input: SendMessageInput,
    options: { extensionActive: boolean },
  ): Promise<SendMessageResult> {
    const messageKey = messageKeyFor(input.messageId);
    const receiptScope = {
      workspaceId: admission.opening.workspaceId,
      messageKey,
      expiresAt: admission.opening.expiresAt ? new Date(admission.opening.expiresAt) : null,
    };
    // A context's first send has no conversation to key a receipt by yet; a retry of it carries no
    // context id, so it is a new context however it is answered. The receipt is read before the
    // task's state, so a retry of the send that finished a task replays it rather than being refused.
    const claimToken = admission.conversationId ? newClaimToken() : null;
    if (admission.conversationId && claimToken) {
      const claim = await this.dependencies.receipts.claim({
        ...receiptScope,
        conversationId: admission.conversationId,
        claimToken,
        staleBefore: new Date(this.clock().getTime() - RECEIPT_STALE_AFTER_MS),
      });
      if (claim.kind === "completed") {
        return this.replay(admission, claim.result, input, options);
      }
      if (claim.kind === "in_flight") {
        throw radiosoError("TURN_IN_PROGRESS");
      }
    }

    try {
      if (admission.task && !isOpenTaskState(admission.task.state)) {
        throw a2aError("UNSUPPORTED_OPERATION");
      }
      const { conversationId, result, receipt } = await this.runTurn(admission, input, options);
      await this.dependencies.receipts.complete({ ...receiptScope, conversationId, claimToken, result: receipt });
      return result;
    } catch (error) {
      if (admission.conversationId && claimToken) {
        await this.release({ conversationId: admission.conversationId, messageKey, claimToken });
      }
      throw error;
    }
  }

  /** A failed send hands its claim back; when that fails too, the claim goes stale and the failure is the turn's own. */
  private async release(claim: { conversationId: string; messageKey: string; claimToken: string }): Promise<void> {
    try {
      await this.dependencies.receipts.release(claim);
    } catch (error) {
      this.dependencies.observer.receiptReleaseFailed({ conversationId: claim.conversationId, error });
    }
  }

  private async runTurn(
    admission: A2aContextAdmission,
    input: SendMessageInput,
    options: { extensionActive: boolean },
  ): Promise<{ conversationId: string; result: SendMessageResult; receipt: A2aReceiptResult }> {
    const openTask = admission.task
      ?? (admission.conversationId ? await this.dependencies.tasks.findOpen(admission.conversationId) : null);
    const before = await this.observeBefore(admission, openTask);

    const turn = await this.dependencies.converse.askAgent(admission.principal, { message: input.text });

    const conversationId = admission.conversationId
      ?? await this.dependencies.transcript.conversationIdFor(admission.opening);
    if (!conversationId) {
      throw new Error("An A2A turn finished without a conversation to record it in");
    }
    const after = await this.observeAfter(admission, conversationId, before.cursor, turn.requestMessageId);
    const facts: TurnTaskFacts = {
      ownership: turn.reply.ownership.state,
      routine: turn.reply.routine ? { status: turn.reply.routine.status, executionId: turn.routineExecutionId } : null,
      activeRoutineExecutionId: turn.activeRoutineExecutionId,
      invocationOutcome: turn.reply.invocation?.outcome ?? null,
      humanReplyDuringTurn: after.humanReplies.length > 0,
      unseenHumanMessages: before.unseenHumans.length > 0,
    };

    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
      const open = attempt === 0 ? openTask : await this.dependencies.tasks.findOpen(conversationId);
      const decision = decideTaskAfterTurn(
        open ? { routineExecutionId: open.routineExecutionId, humanStretch: open.humanStretch } : null,
        facts,
      );
      if (decision.kind === "message") {
        return { conversationId, ...this.plainAnswer(admission, turn, options) };
      }
      const write = this.taskWrite({ admission, conversationId, open, decision, before, after, turn });
      if (await this.dependencies.tasks.commit(write.write) === "committed") {
        for (const state of write.transitions) {
          this.dependencies.observer.transition(state);
        }
        const task = await this.dependencies.view.render(write.task, {
          historyLength: input.historyLength,
          includeArtifacts: true,
          extensionActive: options.extensionActive,
        });
        return { conversationId, result: { task }, receipt: { kind: "task", taskId: write.task.id } };
      }
    }
    throw new Error("An A2A turn could not settle its task against concurrent writers");
  }

  /**
   * With a task open, its cursor is where the caller's view ends. With none, the latest page shows
   * what a person wrote after the caller's previous message, which a new task has to carry.
   */
  private async observeBefore(admission: A2aContextAdmission, openTask: A2aTaskRecord | null): Promise<BeforeTurn> {
    if (openTask) {
      return { cursor: openTask.cursor, unseenHumans: [] };
    }
    if (!admission.conversationId) {
      return { cursor: null, unseenHumans: [] };
    }
    const page = await this.dependencies.transcript.readAfter({
      workspaceId: admission.opening.workspaceId,
      conversationId: admission.conversationId,
      cursor: null,
      limit: LATEST_PAGE_LIMIT,
    });
    return { cursor: page.cursor, unseenHumans: unseenHumanMessages(authoredMessages(page.messages)) };
  }

  /** The turn names its own messages; this read finds where the caller's view now ends, and what a person added. */
  private async observeAfter(
    admission: A2aContextAdmission,
    conversationId: string,
    cursor: string | null,
    requestMessageId: string | null,
  ): Promise<AfterTurn> {
    const page = await readToEnd(this.dependencies.transcript, { workspaceId: admission.opening.workspaceId, conversationId, cursor });
    return { page, humanReplies: humanRepliesAfter(authoredMessages(page.messages), requestMessageId) };
  }

  private plainAnswer(
    admission: A2aContextAdmission,
    turn: AgentConverseTurnResult,
    options: { extensionActive: boolean },
  ): { result: SendMessageResult; receipt: A2aReceiptResult } {
    const envelope = envelopeOf(turn);
    const messageId = turn.replyMessageId;
    if (!messageId) {
      // A receipt must name the stored reply its replay reads back; an AI-owned turn always stores one.
      throw new Error("An A2A plain answer finished without a stored reply");
    }
    return {
      result: {
        message: renderAgentMessage({
          messageId,
          text: turn.reply.answer.text,
          contextId: admission.contextToken,
          extension: options.extensionActive ? { envelope, author: "agent" } : null,
        }),
      },
      receipt: { kind: "message", replyMessageId: messageId, envelope },
    };
  }

  private taskWrite(input: {
    admission: A2aContextAdmission;
    conversationId: string;
    open: A2aTaskRecord | null;
    decision: Extract<TurnTaskDecision, { kind: "task" }>;
    before: BeforeTurn;
    after: AfterTurn;
    turn: AgentConverseTurnResult;
  }): { write: A2aTaskWrite; task: A2aTaskRecord; transitions: A2aTaskRecord["state"][] } {
    const { decision, after, open, turn } = input;
    const now = this.clock();
    const statusMessageId = decision.status === "reply"
      ? turn.replyMessageId
      : decision.status === "later_message" ? after.humanReplies.at(-1)?.id ?? null : null;
    const changes: A2aTaskChanges = {
      routineExecutionId: decision.routineExecutionId,
      callerMessageId: turn.requestMessageId ?? open?.callerMessageId ?? null,
      cursor: after.page.cursor,
      shownThroughMessageId: after.page.messages.at(-1)?.id ?? open?.shownThroughMessageId ?? null,
      statusMessageId,
      artifactMessageId: decision.artifact ? turn.replyMessageId : null,
      envelope: taskEnvelopeOf(turn, open),
      state: decision.state,
      reason: decision.reason,
      stateAt: now,
      ...(marksHumanStretch(decision.reason) ? { humanStretch: true } : {}),
    };
    const replaced = decision.replacesOpenTask && open
      ? [{ id: open.id, expectedVersion: open.version, changes: { state: "canceled", reason: "routine_replaced", statusMessageId: null, stateAt: now } as const }]
      : [];

    if (decision.target === "open" && open) {
      return {
        write: { updates: [{ id: open.id, expectedVersion: open.version, changes }] },
        task: { ...open, ...changes, version: open.version + 1 },
        transitions: open.state === decision.state ? [] : [decision.state],
      };
    }
    const task: Omit<A2aTaskRecord, "version"> = {
      id: newTaskId(),
      workspaceId: input.admission.opening.workspaceId,
      conversationId: input.conversationId,
      contextToken: input.admission.contextToken,
      contextExpiresAt: input.admission.opening.expiresAt ? new Date(input.admission.opening.expiresAt) : null,
      openingMessageId: input.before.unseenHumans[0]?.id ?? turn.requestMessageId ?? after.page.messages[0]?.id ?? null,
      routineExecutionId: null,
      callerMessageId: null,
      cursor: null,
      shownThroughMessageId: null,
      statusMessageId: null,
      artifactMessageId: null,
      envelope: null,
      state: decision.state,
      reason: null,
      humanStretch: false,
      stateAt: now,
      ...changes,
    };
    return {
      write: { updates: replaced, insert: task },
      task: { ...task, version: 1 },
      transitions: [...replaced.map(() => "canceled" as const), decision.state],
    };
  }

  /** A retry of a finished send: the original answer, read back, and no second turn. */
  private async replay(
    admission: A2aContextAdmission,
    result: A2aReceiptResult,
    input: SendMessageInput,
    options: { extensionActive: boolean },
  ): Promise<SendMessageResult> {
    if (result.kind === "task") {
      const task = await this.dependencies.tasks.findById(result.taskId);
      if (!task) {
        throw a2aError("TASK_NOT_FOUND");
      }
      return {
        task: await this.dependencies.view.render(task, {
          historyLength: input.historyLength,
          includeArtifacts: true,
          extensionActive: options.extensionActive,
        }),
      };
    }
    const [reply] = authoredMessages(await this.dependencies.transcript.readRange({
      workspaceId: admission.opening.workspaceId,
      conversationId: admission.conversationId ?? "",
      fromMessageId: result.replyMessageId,
      throughMessageId: result.replyMessageId,
      limit: 1,
    }));
    if (!reply) {
      throw a2aError("INTERNAL_ERROR");
    }
    return {
      message: renderAgentMessage({
        messageId: reply.id,
        text: reply.text,
        contextId: admission.contextToken,
        extension: options.extensionActive ? { envelope: result.envelope, author: "agent" } : null,
      }),
    };
  }
}
