import type { AgentConverseAskResult, ChatCitation } from "../../chat/contracts/index.js";
import type { AgentConverseOpening } from "../../settings/contracts/agentConverseSession.js";
import type { A2aTaskReason, A2aTaskState } from "../domain/taskState.js";

/**
 * What a turn reported that the converse extension carries, kept on a task so a later read renders
 * the same metadata. The routine report, coverage and citations a turn produced: never message text.
 */
export interface A2aTurnEnvelope {
  answerCoverage?: AgentConverseAskResult["answerCoverage"];
  ownership?: AgentConverseAskResult["ownership"];
  routine?: AgentConverseAskResult["routine"];
  invocation?: AgentConverseAskResult["invocation"];
  citations?: ChatCitation[];
}

/**
 * One task: references and state only (FR-031). The context token is the exact id the caller holds,
 * so a task read by its id alone re-verifies the origin it was opened under and renders the same
 * `contextId`; `contextExpiresAt` is the walk-in context's end (null for a grant), for retention.
 */
export interface A2aTaskRecord {
  id: string;
  workspaceId: string;
  conversationId: string;
  contextToken: string;
  contextExpiresAt: Date | null;
  /** The routine run the task follows; null for a stretch of human ownership. */
  routineExecutionId: string | null;
  /** The first message of the task's history. */
  openingMessageId: string | null;
  /** The caller's latest message on the task. */
  callerMessageId: string | null;
  /** Opaque conversation cursor just after the last message the caller has been shown. */
  cursor: string | null;
  /** The message that cursor sits on: the end of the task's history. */
  shownThroughMessageId: string | null;
  statusMessageId: string | null;
  artifactMessageId: string | null;
  envelope: A2aTurnEnvelope | null;
  state: A2aTaskState;
  reason: A2aTaskReason | null;
  /**
   * A person owned the thread or wrote in it while the task was open (row 9). Set once and kept:
   * `reason` says what last moved the task, which a read can rewrite, and this does not change with it.
   */
  humanStretch: boolean;
  stateAt: Date;
  /** Compare-and-set version: a write names the version it read. */
  version: number;
}

/** Fields a write may change; identity, context, and version are the store's. A write can mark a stretch of human ownership, never unmark it. */
export type A2aTaskChanges = Partial<Omit<
  A2aTaskRecord,
  "id" | "workspaceId" | "conversationId" | "contextToken" | "contextExpiresAt" | "version" | "humanStretch"
>> & { humanStretch?: true };

export interface A2aTaskWrite {
  /** Every update must find its task still at `expectedVersion`. */
  updates: readonly { id: string; expectedVersion: number; changes: A2aTaskChanges }[];
  /** A new task at version 1; it fails when its conversation already has an open task. */
  insert?: Omit<A2aTaskRecord, "version">;
}

export interface A2aTaskListQuery {
  conversationId: string;
  state: A2aTaskState | null;
  stateAtOrAfter: Date | null;
  /** Keyset: tasks strictly older than this `(stateAt, id)`, newest status first. */
  before: { stateAt: Date; id: string } | null;
  limit: number;
}

export interface A2aTaskStore {
  findById(id: string): Promise<A2aTaskRecord | null>;
  findOpen(conversationId: string): Promise<A2aTaskRecord | null>;
  /**
   * Applies a write in one transaction, or nothing: `conflict` when an update found a newer version
   * or the insert would open a second task in its conversation.
   */
  commit(write: A2aTaskWrite): Promise<"committed" | "conflict">;
  /** One page of a conversation's tasks, newest status first, and how many match before paging. */
  list(query: A2aTaskListQuery): Promise<{ tasks: A2aTaskRecord[]; total: number }>;
}

/** What a finished `SendMessage` answered, kept so a retry of the same message replays it. */
export type A2aReceiptResult =
  | { kind: "message"; replyMessageId: string; envelope: A2aTurnEnvelope }
  | { kind: "task"; taskId: string };

export type A2aReceiptClaim =
  | { kind: "claimed" }
  | { kind: "in_flight" }
  | { kind: "completed"; result: A2aReceiptResult };

/**
 * Idempotency for `SendMessage` on `(conversation, caller message id)` (FR-038). The caller's id is
 * kept only as a digest. A claim that was never completed or released (a crashed process) is
 * claimable again once it is older than `staleBefore`, by a send holding a new claim token.
 * Completing and releasing name the token, so a send whose claim was taken over changes nothing.
 */
export interface A2aMessageReceiptStore {
  claim(input: {
    workspaceId: string;
    conversationId: string;
    messageKey: string;
    claimToken: string;
    expiresAt: Date | null;
    staleBefore: Date;
  }): Promise<A2aReceiptClaim>;
  /**
   * Records the result under the claim `claimToken` names, while that claim still holds it. A send
   * that claimed nothing (a context's first, whose conversation did not exist) passes null and
   * records it only where no receipt exists.
   */
  complete(input: {
    workspaceId: string;
    conversationId: string;
    messageKey: string;
    claimToken: string | null;
    expiresAt: Date | null;
    result: A2aReceiptResult;
  }): Promise<void>;
  /** Drops the in-flight claim `claimToken` names, and nothing else. */
  release(input: { conversationId: string; messageKey: string; claimToken: string }): Promise<void>;
}

/** One conversation message, with the provenance the conversation stores it under. */
export interface A2aTranscriptMessage {
  id: string;
  /** The stored message source: `customer`, `ai_agent`, `human_agent`, ... */
  source: string;
  text: string;
  createdAt: string;
}

export interface A2aTranscriptPage {
  messages: A2aTranscriptMessage[];
  /** Opaque cursor after the newest message read; null for an empty conversation. */
  cursor: string | null;
  ownership: "ai_owned" | "human_owned";
}

/**
 * The conversation reads tasks are computed from. A read after a cursor is the same read the
 * calling-agent update reader adapts; the range read is a task's own history.
 */
export interface A2aTranscriptPort {
  /** The conversation a context's session id names, once its first turn created it. */
  conversationIdFor(opening: Pick<AgentConverseOpening, "workspaceId" | "agentId" | "publicSessionId">): Promise<string | null>;
  /** Messages after `cursor`, oldest first; with no cursor, the newest `limit` messages. */
  readAfter(input: { workspaceId: string; conversationId: string; cursor: string | null; limit: number }): Promise<A2aTranscriptPage>;
  /** The newest `limit` messages from `fromMessageId` through `throughMessageId`, both included, oldest first. */
  readRange(input: {
    workspaceId: string;
    conversationId: string;
    fromMessageId: string;
    throughMessageId: string;
    limit: number;
  }): Promise<A2aTranscriptMessage[]>;
}

/** Seals a converse opening into the context id a caller holds, and opens it again. */
export interface A2aContextSealer {
  seal(opening: AgentConverseOpening): string;
  /** The opening, or null for a token this server did not issue or can no longer read. */
  open(token: string): AgentConverseOpening | null;
}

/**
 * The agent a public id serves A2A for: null for every id whose card answers 404 (unknown, card
 * switched off, unpublished, deleted), so the endpoint answers those identically.
 */
export interface A2aAgentDirectory {
  resolve(publicId: string): Promise<{ agentId: string; workspaceId: string } | null>;
}
