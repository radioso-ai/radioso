import { randomUUID } from "node:crypto";

import {
  bindDeliveryFailureRecorder,
  DeliveryFailures,
  type DeliveryFailureReadStore,
  type DeliveryFailureRecord,
  type DeliveryFailureWriteStore,
} from "../../src/modules/customerReplyDelivery/public.js";
import type { ConversationActivityEvent } from "../../src/modules/conversationActivity/contracts/index.js";

type Position = { openedAt: Date; id: string } | null;

const newestFirst = (left: DeliveryFailureRecord, right: DeliveryFailureRecord): number =>
  right.openedAt.getTime() - left.openedAt.getTime() || (right.id < left.id ? -1 : right.id > left.id ? 1 : 0);

const after = (position: Position) => (failure: DeliveryFailureRecord): boolean =>
  position === null
  || failure.openedAt.getTime() < position.openedAt.getTime()
  || (failure.openedAt.getTime() === position.openedAt.getTime() && failure.id < position.id);

/**
 * `conversation_delivery_failures` in memory, with the rules the Postgres repository keeps: one open
 * failure per conversation and message, newest-first pages, and the agent filter over the
 * conversation's agent.
 */
export const createInMemoryDeliveryFailures = (options: { agentOf?: (conversationId: string) => string | null } = {}) => {
  const rows: DeliveryFailureRecord[] = [];
  const activities: ConversationActivityEvent[] = [];
  let clock = Date.parse("2026-10-03T10:00:00.000Z");
  const tick = () => new Date((clock += 1000));
  const copy = (row: DeliveryFailureRecord): DeliveryFailureRecord => ({ ...row });
  const openOn = (conversationId: string, messageId: string | null) => (row: DeliveryFailureRecord) =>
    row.clearedAt === null && row.conversationId === conversationId && row.messageId === messageId;
  const ofAgent = (agentId: string | undefined) => (row: DeliveryFailureRecord) =>
    agentId === undefined || options.agentOf?.(row.conversationId) === agentId;

  const writes: DeliveryFailureWriteStore = {
    async insertOpen(input) {
      if (rows.some(openOn(input.conversationId, input.messageId))) return null;
      const row: DeliveryFailureRecord = {
        id: randomUUID(),
        ...input,
        openedAt: tick(),
        clearedAt: null,
        clearedByUserId: null,
        clearReason: null,
      };
      rows.push(row);
      return copy(row);
    },
    async retargetOpen(input) {
      const row = rows.find((candidate) => openOn(input.conversationId, input.messageId)(candidate) && candidate.kind !== input.kind);
      if (!row) return null;
      Object.assign(row, { kind: input.kind, detailCode: input.detailCode });
      return copy(row);
    },
    async clearOpen(input) {
      const { target } = input;
      const cleared = rows.filter((row) =>
        row.clearedAt === null
        && ("failureId" in target
          ? row.id === target.failureId
          : row.conversationId === target.conversationId && row.messageId !== null && target.messageIds.includes(row.messageId)));
      const at = tick();
      for (const row of cleared) {
        Object.assign(row, { clearedAt: at, clearReason: input.reason, clearedByUserId: input.clearedByUserId });
      }
      return cleared.map(copy);
    },
    async lockOpen(input) {
      const row = rows.find((candidate) =>
        candidate.id === input.failureId && candidate.workspaceId === input.workspaceId && candidate.clearedAt === null);
      return row ? copy(row) : null;
    },
    async acknowledgeOpen(input) {
      const row = rows.find((candidate) =>
        candidate.id === input.failureId && candidate.workspaceId === input.workspaceId && candidate.clearedAt === null);
      if (!row) return null;
      Object.assign(row, { clearedAt: tick(), clearReason: "acknowledged", clearedByUserId: input.userId });
      return copy(row);
    },
  };

  const reads: DeliveryFailureReadStore = {
    async listOpen(workspaceId, query) {
      return rows
        .filter((row) => row.workspaceId === workspaceId && row.clearedAt === null)
        .filter(ofAgent(query.agentId))
        .sort(newestFirst)
        .filter(after(query.after))
        .slice(0, query.limit)
        .map(copy);
    },
    async listAll(workspaceId, query) {
      return rows
        .filter((row) => row.workspaceId === workspaceId)
        .filter(ofAgent(query.agentId))
        .sort(newestFirst)
        .filter(after(query.after))
        .slice(0, query.limit)
        .map(copy);
    },
    async find(workspaceId, failureId) {
      const row = rows.find((candidate) => candidate.id === failureId && candidate.workspaceId === workspaceId);
      return row ? copy(row) : null;
    },
    async listOldestOpen(workspaceId, query) {
      return rows
        .filter((row) => row.workspaceId === workspaceId && row.clearedAt === null)
        .filter(ofAgent(query.agentId))
        .sort(newestFirst)
        .reverse()
        .slice(0, query.limit)
        .map(({ id, conversationId, kind, detailCode, openedAt }) => ({ id, conversationId, kind, detailCode, openedAt }));
    },
    async countOpen(workspaceId, query) {
      return rows.filter((row) => row.workspaceId === workspaceId && row.clearedAt === null).filter(ofAgent(query.agentId)).length;
    },
  };

  const activity = { record: async (event: ConversationActivityEvent) => { activities.push(event); } };
  const failures = new DeliveryFailures({ writes: { run: async (work) => work({ failures: writes, activity }) }, reads });
  /** The recorder as a channel binds it inside its own transaction, with the lock a decision takes. */
  const recorder = bindDeliveryFailureRecorder({ failures: writes, activity });

  return { rows, activities, failures, recorder };
};
