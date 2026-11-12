import type { AuditEventInput } from "../audit/contracts/index.js";
import type { MessageCopyWithholder } from "../../shared/domain/messageWithholding.js";
import type { RoutineConsentRecord } from "../../shared/domain/routineConsentRecord.js";
import type { ConversationErasureActor } from "./conversationErasure.js";

/**
 * Withdrawing a visitor's consent (#1544, Article 7(3)): an operator does it on the visitor's
 * request. The values the consent covered are erased from the conversation's routine state, the
 * messages that carried them keep the redaction marker as their text and are marked withheld, every
 * module's copies of those messages are withheld with them, and the record keeps its proof with the
 * withdrawal and the member who made it.
 *
 * The record names the slots it covered, so a withdrawal never reads a routine definition.
 */

/** Who withdrew a consent: the signed-in teammate, or a credential's owner. */
type ConsentWithdrawalActor = ConversationErasureActor;

/** One consent decision as a conversation's consents read it: the proof, never a value or a reply. */
export type ConsentRecord = RoutineConsentRecord;

type ConsentNotWithdrawableReason = "declined" | "already_withdrawn";

export type ConsentWithdrawalOutcome =
  | { kind: "withdrawn"; consent: ConsentRecord }
  | { kind: "not_found" }
  /** Nothing changed; `consent` is the record as it stands. */
  | { kind: "not_withdrawable"; reason: ConsentNotWithdrawableReason; consent: ConsentRecord };

/** A conversation's consent records, and the withdrawal of one of them. */
export interface ConversationConsents {
  /** The records a conversation's consents left, oldest decision first; they outlive the conversation. */
  list(input: { workspaceId: string; conversationId: string }): Promise<ConsentRecord[]>;
  withdraw(input: {
    workspaceId: string;
    conversationId: string;
    recordId: string;
    actor: ConsentWithdrawalActor;
  }): Promise<ConsentWithdrawalOutcome>;
}

/** The consent records as a read sees them. */
interface ConsentRecordReader {
  listForConversation(input: { workspaceId: string; conversationId: string }): Promise<ConsentRecord[]>;
}

/** One withdrawal transaction: the record, the values and messages it reaches, every module's copies, and its audit record. */
export interface ConsentWithdrawalWriteScope {
  records: {
    /** Locks the record until the transaction ends; null when the workspace has no such record in the conversation. */
    lock(input: { workspaceId: string; conversationId: string; recordId: string }): Promise<ConsentRecord | null>;
    /** Marks the record withdrawn by the actor and returns when, on the database clock. */
    markWithdrawn(input: { recordId: string; actor: ConsentWithdrawalActor }): Promise<Date>;
  };
  routineValues: {
    /** Erases the slots' values from the conversation's state of the routine, a completed run's included. */
    erase(input: { conversationId: string; routineId: string; slotKeys: readonly string[] }): Promise<void>;
  };
  messages: {
    /**
     * Withholds the conversation's messages marked as carrying any of the slots: their text becomes
     * the redaction marker and they record the withholding at `at`. Returns their ids.
     */
    withhold(input: { workspaceId: string; conversationId: string; slotKeys: readonly string[]; at: Date }): Promise<string[]>;
  };
  messageCopies: readonly MessageCopyWithholder[];
  audit: { record(event: AuditEventInput): Promise<void> };
}

export interface ConsentWithdrawalUnitOfWork {
  run<T>(work: (scope: ConsentWithdrawalWriteScope) => Promise<T>): Promise<T>;
}

/** What a committed withdrawal reports: ids, keys and a count, never the wording or a value. */
export interface ConsentWithdrawn {
  workspaceId: string;
  conversationId: string;
  channel: string | null;
  routineId: string;
  consentKey: string;
  wordingVersionId: string;
  recordId: string;
  withheldMessageCount: number;
}

interface ConsentWithdrawalTelemetry {
  withdrawn(event: ConsentWithdrawn): void;
}

interface ConsentWithdrawalDependencies {
  unitOfWork: ConsentWithdrawalUnitOfWork;
  records: ConsentRecordReader;
  /** Logs a committed audit event. */
  auditLog: { logRecorded?(event: AuditEventInput): void };
  telemetry: ConsentWithdrawalTelemetry;
}

/** The refusal a record earns as it stands, or null when it can be withdrawn. */
const refusalFor = (record: ConsentRecord): ConsentNotWithdrawableReason | null => {
  if (record.decision !== "granted") return "declined";
  return record.withdrawnAt ? "already_withdrawn" : null;
};

export class ConsentWithdrawalService implements ConversationConsents {
  constructor(private readonly deps: ConsentWithdrawalDependencies) {}

  list(input: { workspaceId: string; conversationId: string }): Promise<ConsentRecord[]> {
    return this.deps.records.listForConversation(input);
  }

  /**
   * Withdraws a granted consent in one transaction. A refusal or an unknown record changes nothing
   * and records nothing; the audit log line and the telemetry follow only a committed withdrawal.
   */
  async withdraw(input: {
    workspaceId: string;
    conversationId: string;
    recordId: string;
    actor: ConsentWithdrawalActor;
  }): Promise<ConsentWithdrawalOutcome> {
    let committed: { event: AuditEventInput; withdrawn: ConsentWithdrawn } | null = null;
    const outcome = await this.deps.unitOfWork.run(async (scope): Promise<ConsentWithdrawalOutcome> => {
      committed = null;
      const record = await scope.records.lock(input);
      if (!record) return { kind: "not_found" };
      const refusal = refusalFor(record);
      if (refusal) return { kind: "not_withdrawable", reason: refusal, consent: record };

      const withdrawnAt = await scope.records.markWithdrawn({ recordId: record.id, actor: input.actor });
      await scope.routineValues.erase({ conversationId: input.conversationId, routineId: record.routineId, slotKeys: record.slotKeys });
      const messageIds = await scope.messages.withhold({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        slotKeys: record.slotKeys,
        at: withdrawnAt,
      });
      const rowsByOwner: Record<string, number> = {};
      if (messageIds.length > 0) {
        for (const copies of scope.messageCopies) {
          const rows = await copies.withhold({ workspaceId: input.workspaceId, conversationId: input.conversationId, messageIds });
          rowsByOwner[copies.owner] = (rowsByOwner[copies.owner] ?? 0) + rows;
        }
      }
      const event: AuditEventInput = {
        accountId: input.actor.accountId,
        workspaceId: input.workspaceId,
        eventType: "routine_consent.withdrawn",
        eventStatus: "success",
        metadata: {
          actorUserId: input.actor.userId,
          conversationId: input.conversationId,
          routineId: record.routineId,
          consentKey: record.consentKey,
          recordId: record.id,
          withheldMessageCount: messageIds.length,
          rowsByOwner,
        },
      };
      await scope.audit.record(event);
      committed = {
        event,
        withdrawn: {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          channel: record.channel,
          routineId: record.routineId,
          consentKey: record.consentKey,
          wordingVersionId: record.wordingVersionId,
          recordId: record.id,
          withheldMessageCount: messageIds.length,
        },
      };
      return { kind: "withdrawn", consent: { ...record, withdrawnAt } };
    });
    const reported = committed as { event: AuditEventInput; withdrawn: ConsentWithdrawn } | null;
    if (reported) {
      this.deps.auditLog.logRecorded?.(reported.event);
      this.deps.telemetry.withdrawn(reported.withdrawn);
    }
    return outcome;
  }
}
