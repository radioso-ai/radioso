import { createHash, randomBytes } from "node:crypto";

import type { AgentConverseService, AgentConverseTurnResult } from "../../chat/contracts/index.js";
import type {
  A2aMessageReceiptStore,
  A2aReceiptResult,
  A2aRoutineRunReader,
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
import { authoredMessages, unseenHumanMessages, type AuthoredMessage } from "../domain/turnMessages.js";
import type { A2aContextAdmission } from "./a2aAccess.js";
import type { A2aObserver } from "./a2aObserver.js";
import type { A2aTaskView } from "./a2aTaskView.js";
import { readToEnd } from "./transcriptReads.js";

export type SendMessageResult = { message: WireMessage } | { task: WireTask };

type SendOptions = { extensionActive: boolean };

/** The latest messages a turn reads, with no task open, to find a person's messages the caller has not seen. */
const LATEST_PAGE_LIMIT = 50;

/** A claim older than this is a send that died with its process, not one still running. */
const RECEIPT_STALE_AFTER_MS = 10 * 60 * 1_000;

/** Compare-and-set attempts before a turn's settlement gives up against concurrent writers. */
const SETTLE_ATTEMPTS = 3;

/** Attempts at recording a finished send's receipt before its claim is left to go stale. */
const RECEIPT_COMPLETE_ATTEMPTS = 3;

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
const taskEnvelopeOf = (turn: AgentConverseTurnResult, activeRunId: string | null, open: A2aTaskRecord | null): A2aTurnEnvelope => {
  const envelope = envelopeOf(turn);
  const yieldedRun = !envelope.routine && activeRunId !== null && open?.routineExecutionId === activeRunId;
  return yieldedRun && open.envelope?.routine ? { ...envelope, routine: open.envelope.routine } : envelope;
};

/** Where the conversation stood before the turn, as far as the caller had been shown it. */
interface BeforeTurn {
  openTask: A2aTaskRecord | null;
  cursor: string | null;
  /** With no task open: what a person wrote after the caller's previous message. */
  unseenHumans: AuthoredMessage[];
}

/** A turn that ran, with what its settlement reads: its conversation and the run still active after it. */
interface RanTurn {
  turn: AgentConverseTurnResult;
  conversationId: string;
  before: BeforeTurn;
  activeRunId: string | null;
}

/**
 * The conversation after the turn, read past the cursor it started from: where the caller's view
 * now ends, and every person's message the caller has not been shown.
 */
interface AfterTurn {
  page: A2aTranscriptPage;
  /** The authored messages past the cursor, oldest first. */
  pastCursor: AuthoredMessage[];
  /**
   * A person's messages the caller has not been shown, oldest first: after its previous message (no
   * task open) or past the open task's cursor, whether written before the turn's own message or after it.
   */
  unseenHumans: AuthoredMessage[];
}

/** What a send answers and what its receipt keeps: a plain answer, or the task the turn left. */
type Settled =
  | { kind: "message"; result: SendMessageResult; receipt: A2aReceiptResult }
  | { kind: "task"; task: A2aTaskRecord; receipt: A2aReceiptResult };

/**
 * `SendMessage`: one converse turn, and the task bookkeeping around it (FR-033, FR-034, FR-038).
 * It returns when the turn finishes. A plain answer with nothing pending is a `Message` and leaves
 * no record; anything else is the task the turn ended in, opened, continued or replaced by the
 * precedence table. Task writes compare and set, so a concurrent read computed from an older
 * snapshot never overwrites what this turn decided: on a conflict the turn re-decides against the
 * task as it now stands.
 *
 * Once the turn has run, a retry of the message replays it and never runs it again: only a send
 * that failed before its turn ran hands its claim back.
 */
export class A2aSendMessageService {
  private readonly clock: () => Date;

  constructor(
    private readonly dependencies: {
      converse: Pick<AgentConverseService, "askAgent">;
      tasks: A2aTaskStore;
      receipts: A2aMessageReceiptStore;
      transcript: A2aTranscriptPort;
      routineRuns: A2aRoutineRunReader;
      view: A2aTaskView;
      observer: A2aObserver;
      clock?: () => Date;
    },
  ) {
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async send(admission: A2aContextAdmission, input: SendMessageInput, options: SendOptions): Promise<SendMessageResult> {
    const messageKey = messageKeyFor(input.messageId);
    const receiptScope = {
      workspaceId: admission.opening.workspaceId,
      messageKey,
      expiresAt: admission.opening.expiresAt ? new Date(admission.opening.expiresAt) : null,
    };
    // A context's first send has no conversation to key a receipt by yet; a retry of it carries no
    // context id, so it is a new context however it is answered. The receipt is read before the
    // task's state, so a retry of the send that finished a task replays it rather than being refused.
    const claim = admission.conversationId ? { conversationId: admission.conversationId, messageKey, claimToken: newClaimToken() } : null;
    if (claim) {
      const claimed = await this.dependencies.receipts.claim({
        ...receiptScope,
        ...claim,
        staleBefore: new Date(this.clock().getTime() - RECEIPT_STALE_AFTER_MS),
      });
      if (claimed.kind === "completed") {
        return this.replay(admission, claim.conversationId, claimed.result, input, options);
      }
      if (claimed.kind === "in_flight") {
        throw radiosoError("TURN_IN_PROGRESS");
      }
    }

    const ran = await this.runTurn(admission, input, claim);
    // The turn has run. Nothing below hands the claim back, so a retry replays and never runs it again.
    const settled = await this.settleOrRecordKnown(admission, ran, options);
    await this.complete({ ...receiptScope, conversationId: ran.conversationId, claimToken: claim?.claimToken ?? null, result: settled.receipt });
    return settled.kind === "message" ? settled.result : { task: await this.render(settled.task, input, options) };
  }

  /** Runs the turn; a send that fails before its turn has run hands its claim back, so a retry runs it. */
  private async runTurn(
    admission: A2aContextAdmission,
    input: SendMessageInput,
    claim: { conversationId: string; messageKey: string; claimToken: string } | null,
  ): Promise<RanTurn> {
    let before: BeforeTurn;
    let turn: AgentConverseTurnResult;
    try {
      if (admission.task && !isOpenTaskState(admission.task.state)) {
        throw a2aError("UNSUPPORTED_OPERATION");
      }
      before = await this.observeBefore(admission);
      turn = await this.dependencies.converse.askAgent(admission.principal, { message: input.text });
    } catch (error) {
      if (claim) {
        await this.release(claim);
      }
      throw error;
    }
    const conversationId = admission.conversationId ?? turn.conversationId;
    return { turn, conversationId, before, activeRunId: await this.activeRoutineRun(conversationId, before.openTask) };
  }

  /** A failed send hands its claim back; when that fails too, the claim goes stale and the failure is the turn's own. */
  private async release(claim: { conversationId: string; messageKey: string; claimToken: string }): Promise<void> {
    try {
      await this.dependencies.receipts.release(claim);
    } catch (error) {
      this.dependencies.observer.receiptReleaseFailed({ conversationId: claim.conversationId, error });
    }
  }

  /**
   * Records what a retry replays, a few times over. A receipt that still cannot be recorded leaves
   * the claim in flight, so a retry is answered `TURN_IN_PROGRESS` rather than running the turn
   * again, until the claim goes stale; the caller still gets the answer the turn produced.
   */
  private async complete(input: Parameters<A2aMessageReceiptStore["complete"]>[0]): Promise<void> {
    let failure: unknown;
    for (let attempt = 0; attempt < RECEIPT_COMPLETE_ATTEMPTS; attempt += 1) {
      try {
        await this.dependencies.receipts.complete(input);
        return;
      } catch (error) {
        failure = error;
      }
    }
    this.dependencies.observer.afterTurnFailed({ step: "receipt_completion", conversationId: input.conversationId, error: failure });
  }

  /**
   * The routine run still active once the turn finished. A read that fails takes the run the open
   * task follows to be still active, so no task is canceled (row 10) on a read that never happened.
   */
  private async activeRoutineRun(conversationId: string, openTask: A2aTaskRecord | null): Promise<string | null> {
    try {
      return await this.dependencies.routineRuns.activeExecutionId(conversationId);
    } catch (error) {
      this.dependencies.observer.afterTurnFailed({ step: "routine_run_read", conversationId, error });
      return openTask?.routineExecutionId ?? null;
    }
  }

  /**
   * Settles the turn's task. When that fails, or loses to concurrent writers every time, a retry must
   * still replay rather than run the turn again: what is known is recorded instead, the task now
   * open in the conversation (which the turn's messages continue), or else the turn's own reply.
   */
  private async settleOrRecordKnown(admission: A2aContextAdmission, ran: RanTurn, options: SendOptions): Promise<Settled> {
    try {
      return await this.settle(admission, ran, options);
    } catch (error) {
      this.dependencies.observer.afterTurnFailed({ step: "task_settlement", conversationId: ran.conversationId, error });
      const open = await this.dependencies.tasks.findOpen(ran.conversationId).catch(() => null);
      if (open) {
        return { kind: "task", task: open, receipt: { kind: "task", taskId: open.id } };
      }
      if (ran.turn.replyMessageId) {
        return { kind: "message", ...this.plainAnswer(admission, ran.turn, options) };
      }
      throw error;
    }
  }

  private async settle(admission: A2aContextAdmission, ran: RanTurn, options: SendOptions): Promise<Settled> {
    const { turn, conversationId, before } = ran;
    const after = await this.observeAfter(admission, conversationId, before);
    const facts: TurnTaskFacts = {
      ownership: turn.reply.ownership.state,
      routine: turn.reply.routine ? { status: turn.reply.routine.status, executionId: turn.routineExecutionId } : null,
      activeRoutineExecutionId: ran.activeRunId,
      invocationOutcome: turn.reply.invocation?.outcome ?? null,
      unseenHumanMessages: after.unseenHumans.length > 0,
    };

    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
      const open = attempt === 0 ? before.openTask : await this.dependencies.tasks.findOpen(conversationId);
      const decision = decideTaskAfterTurn(
        open ? { routineExecutionId: open.routineExecutionId, humanStretch: open.humanStretch } : null,
        facts,
      );
      if (decision.kind === "message") {
        return { kind: "message", ...this.plainAnswer(admission, turn, options) };
      }
      const write = this.taskWrite({ admission, ran, open, decision, after });
      if (await this.dependencies.tasks.commit(write.write) === "committed") {
        for (const state of write.transitions) {
          this.dependencies.observer.transition(state);
        }
        return { kind: "task", task: write.task, receipt: { kind: "task", taskId: write.task.id } };
      }
    }
    throw new Error("An A2A turn could not settle its task against concurrent writers");
  }

  /**
   * With a task open, its cursor is where the caller's view ends. With none, the latest page shows
   * what a person wrote after the caller's previous message, which a new task has to carry.
   */
  private async observeBefore(admission: A2aContextAdmission): Promise<BeforeTurn> {
    const openTask = admission.task
      ?? (admission.conversationId ? await this.dependencies.tasks.findOpen(admission.conversationId) : null);
    if (openTask) {
      return { openTask, cursor: openTask.cursor, unseenHumans: [] };
    }
    if (!admission.conversationId) {
      return { openTask, cursor: null, unseenHumans: [] };
    }
    const page = await this.dependencies.transcript.readAfter({
      workspaceId: admission.opening.workspaceId,
      conversationId: admission.conversationId,
      cursor: null,
      limit: LATEST_PAGE_LIMIT,
    });
    return { openTask, cursor: page.cursor, unseenHumans: unseenHumanMessages(authoredMessages(page.messages)) };
  }

  /** The turn names its own messages; this read finds where the caller's view now ends, and what a person wrote that it has not seen. */
  private async observeAfter(admission: A2aContextAdmission, conversationId: string, before: BeforeTurn): Promise<AfterTurn> {
    const page = await readToEnd(this.dependencies.transcript, { workspaceId: admission.opening.workspaceId, conversationId, cursor: before.cursor });
    const pastCursor = authoredMessages(page.messages);
    return {
      page,
      pastCursor,
      unseenHumans: [...before.unseenHumans, ...pastCursor.filter((message) => message.author === "human")],
    };
  }

  private plainAnswer(
    admission: A2aContextAdmission,
    turn: AgentConverseTurnResult,
    options: SendOptions,
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
    ran: RanTurn;
    open: A2aTaskRecord | null;
    decision: Extract<TurnTaskDecision, { kind: "task" }>;
    after: AfterTurn;
  }): { write: A2aTaskWrite; task: A2aTaskRecord; transitions: A2aTaskRecord["state"][] } {
    const { decision, after, open, ran: { turn, before } } = input;
    const now = this.clock();
    const statusMessageId = decision.status === "reply"
      ? turn.replyMessageId
      : decision.status === "later_message" ? after.unseenHumans.at(-1)?.id ?? null : null;
    const changes: A2aTaskChanges = {
      routineExecutionId: decision.routineExecutionId,
      callerMessageId: turn.requestMessageId ?? open?.callerMessageId ?? null,
      cursor: after.page.cursor,
      shownThroughMessageId: after.page.messages.at(-1)?.id ?? open?.shownThroughMessageId ?? null,
      statusMessageId,
      artifactMessageId: decision.artifact ? turn.replyMessageId : null,
      envelope: taskEnvelopeOf(turn, input.ran.activeRunId, open),
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
    // A new task starts at the first message it has to carry: a person's the caller has not seen, or the caller's own.
    const openingMessageId = before.unseenHumans[0]?.id
      ?? after.pastCursor.find((message) => message.author === "human" || message.id === turn.requestMessageId)?.id
      ?? turn.requestMessageId
      ?? after.page.messages[0]?.id
      ?? null;
    const task: Omit<A2aTaskRecord, "version"> = {
      id: newTaskId(),
      workspaceId: input.admission.opening.workspaceId,
      conversationId: input.ran.conversationId,
      contextToken: input.admission.contextToken,
      contextExpiresAt: input.admission.opening.expiresAt ? new Date(input.admission.opening.expiresAt) : null,
      openingMessageId,
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

  private render(task: A2aTaskRecord, input: SendMessageInput, options: SendOptions): Promise<WireTask> {
    return this.dependencies.view.render(task, {
      historyLength: input.historyLength,
      includeArtifacts: true,
      extensionActive: options.extensionActive,
    });
  }

  /** A retry of a finished send: the original answer, read back, and no second turn. */
  private async replay(
    admission: A2aContextAdmission,
    conversationId: string,
    result: A2aReceiptResult,
    input: SendMessageInput,
    options: SendOptions,
  ): Promise<SendMessageResult> {
    if (result.kind === "task") {
      const task = await this.dependencies.tasks.findById(result.taskId);
      if (!task) {
        throw a2aError("TASK_NOT_FOUND");
      }
      return { task: await this.render(task, input, options) };
    }
    const [reply] = authoredMessages(await this.dependencies.transcript.readRange({
      workspaceId: admission.opening.workspaceId,
      conversationId,
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
