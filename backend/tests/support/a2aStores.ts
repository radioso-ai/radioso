import type {
  A2aMessageReceiptStore,
  A2aReceiptClaim,
  A2aReceiptResult,
  A2aTaskListQuery,
  A2aTaskRecord,
  A2aTaskStore,
  A2aTaskWrite,
} from "../../src/modules/a2a/public.js";
import { OPEN_TASK_STATES } from "../../src/modules/a2a/public.js";

const isOpen = (state: string): boolean => (OPEN_TASK_STATES as readonly string[]).includes(state);

/** The A2A task store with the Postgres repository's semantics: compare-and-set, one open task per conversation. */
export class InMemoryA2aTaskStore implements A2aTaskStore {
  readonly tasks = new Map<string, A2aTaskRecord>();

  async findById(id: string): Promise<A2aTaskRecord | null> {
    const task = this.tasks.get(id);
    return task ? { ...task } : null;
  }

  async findOpen(conversationId: string): Promise<A2aTaskRecord | null> {
    const task = [...this.tasks.values()].find((entry) => entry.conversationId === conversationId && isOpen(entry.state));
    return task ? { ...task } : null;
  }

  async commit(write: A2aTaskWrite): Promise<"committed" | "conflict"> {
    const next = new Map(this.tasks);
    for (const update of write.updates) {
      const task = next.get(update.id);
      if (!task || task.version !== update.expectedVersion) {
        return "conflict";
      }
      next.set(update.id, { ...task, ...update.changes, version: task.version + 1 });
    }
    if (write.insert) {
      const insert = write.insert;
      const openSibling = [...next.values()].some((task) => task.conversationId === insert.conversationId && isOpen(task.state));
      if (next.has(insert.id) || (isOpen(insert.state) && openSibling)) {
        return "conflict";
      }
      next.set(insert.id, { ...insert, version: 1 });
    }
    this.tasks.clear();
    for (const [id, task] of next) {
      this.tasks.set(id, task);
    }
    return "committed";
  }

  async list(query: A2aTaskListQuery): Promise<{ tasks: A2aTaskRecord[]; total: number }> {
    const matching = [...this.tasks.values()]
      .filter((task) => task.conversationId === query.conversationId)
      .filter((task) => !query.state || task.state === query.state)
      .filter((task) => !query.stateAfter || task.stateAt.getTime() > query.stateAfter.getTime())
      .sort((a, b) => b.stateAt.getTime() - a.stateAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const before = query.before;
    const page = before
      ? matching.filter((task) => task.stateAt.getTime() < before.stateAt.getTime()
        || (task.stateAt.getTime() === before.stateAt.getTime() && task.id < before.id))
      : matching;
    return { tasks: page.slice(0, query.limit).map((task) => ({ ...task })), total: matching.length };
  }
}

interface StoredReceipt {
  state: "in_flight" | "completed";
  result: A2aReceiptResult | null;
  claimToken: string | null;
  claimedAt: Date;
}

/** The receipt store with the Postgres repository's semantics: a claim is completed or released only by the token that holds it. */
export class InMemoryA2aMessageReceiptStore implements A2aMessageReceiptStore {
  readonly receipts = new Map<string, StoredReceipt>();

  private key(conversationId: string, messageKey: string): string {
    return `${conversationId}:${messageKey}`;
  }

  async claim(input: Parameters<A2aMessageReceiptStore["claim"]>[0]): Promise<A2aReceiptClaim> {
    const key = this.key(input.conversationId, input.messageKey);
    const existing = this.receipts.get(key);
    if (!existing || (existing.state === "in_flight" && existing.claimedAt < input.staleBefore)) {
      this.receipts.set(key, { state: "in_flight", result: null, claimToken: input.claimToken, claimedAt: new Date() });
      return { kind: "claimed" };
    }
    return existing.state === "completed" && existing.result ? { kind: "completed", result: existing.result } : { kind: "in_flight" };
  }

  async complete(input: Parameters<A2aMessageReceiptStore["complete"]>[0]): Promise<void> {
    const key = this.key(input.conversationId, input.messageKey);
    const existing = this.receipts.get(key);
    const holdsClaim = input.claimToken === null
      ? existing === undefined
      : existing?.state === "in_flight" && existing.claimToken === input.claimToken;
    if (holdsClaim) {
      this.receipts.set(key, { state: "completed", result: input.result, claimToken: input.claimToken, claimedAt: existing?.claimedAt ?? new Date() });
    }
  }

  async release(input: Parameters<A2aMessageReceiptStore["release"]>[0]): Promise<void> {
    const key = this.key(input.conversationId, input.messageKey);
    const existing = this.receipts.get(key);
    if (existing?.state === "in_flight" && existing.claimToken === input.claimToken) {
      this.receipts.delete(key);
    }
  }
}
