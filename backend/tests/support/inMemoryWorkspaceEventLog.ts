import { randomUUID } from "node:crypto";

import type { StoredLogEvent, WorkspaceEventLogStore, WorkspaceEventType } from "../../src/shared/domain/workspaceEventLog.js";

const compare = (left: { tx: string; position: string }, right: { tx: string; position: string }): number => {
  const tx = BigInt(left.tx) - BigInt(right.tx);
  if (tx !== 0n) return tx < 0n ? -1 : 1;
  const position = BigInt(left.position) - BigInt(right.position);
  return position === 0n ? 0 : position < 0n ? -1 : 1;
};

/**
 * The event log's store in memory, with a horizon a test moves by hand: an event appended "in
 * flight" stays above it, as an uncommitted transaction's row does in Postgres.
 */
export class InMemoryWorkspaceEventLogStore implements WorkspaceEventLogStore {
  private readonly events: StoredLogEvent[] = [];
  private nextTx = 100n;
  private nextPosition = 1n;
  private inFlight = new Set<string>();

  /** Appends a committed event in its own transaction, or in `tx` when one is named. */
  append(input: {
    workspaceId: string;
    type: WorkspaceEventType;
    conversationId?: string;
    data?: Record<string, unknown>;
    tx?: string;
    occurredAt?: Date;
  }): StoredLogEvent {
    const event: StoredLogEvent = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      type: input.type,
      version: 1,
      occurredAt: input.occurredAt ?? new Date(),
      tx: input.tx ?? String(this.nextTx++),
      position: String(this.nextPosition++),
      conversationId: input.conversationId ?? randomUUID(),
      agentId: null,
      channel: "web",
      callerKind: "human",
      visitorId: null,
      data: input.data ?? {},
    };
    this.events.push(event);
    return event;
  }

  /** A transaction that has begun and not finished: its rows, and every later one, wait. */
  begin(): string {
    const tx = String(this.nextTx++);
    this.inFlight.add(tx);
    return tx;
  }

  commit(tx: string): void {
    this.inFlight.delete(tx);
  }

  private horizon(): string {
    const running = [...this.inFlight].map((tx) => BigInt(tx));
    return String(running.length > 0 ? running.reduce((low, tx) => (tx < low ? tx : low)) : this.nextTx);
  }

  async readPage(input: {
    workspaceId: string;
    types: readonly WorkspaceEventType[];
    after: { tx: string; position: string } | null;
    limit: number;
  }): Promise<{ events: StoredLogEvent[]; horizon: string; horizonXidSpan: number }> {
    const horizon = this.horizon();
    const below = this.events
      .filter((event) => event.workspaceId === input.workspaceId && input.types.includes(event.type))
      .filter((event) => BigInt(event.tx) < BigInt(horizon))
      .sort(compare);
    const page = input.after
      ? below.filter((event) => compare(event, input.after!) > 0).slice(0, input.limit)
      : below.reverse().slice(0, input.limit);
    return { events: page, horizon, horizonXidSpan: Number(this.nextTx - BigInt(horizon)) };
  }
}
