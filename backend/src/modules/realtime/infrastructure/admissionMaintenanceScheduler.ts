import { MonotonicDueHeap } from "./monotonicDueHeap.js";

export type AdmissionDueWork = { aggregateId: string; dueAtMs: number; version: number };

type Callbacks = {
  now(): number;
  isCurrent(work: AdmissionDueWork): boolean;
  sweep(accountId: string): Promise<{ hasMore: boolean }>;
  renew(work: readonly AdmissionDueWork[]): Promise<void>;
};

/** One timer for admission maintenance: bounded fair sweep work plus due renewals. */
export class AdmissionMaintenanceScheduler {
  private readonly heap = new MonotonicDueHeap<AdmissionDueWork>();
  private readonly dueByAggregate = new Map<string, AdmissionDueWork>();
  private readonly accounts: string[] = [];
  private readonly accountIndex = new Map<string, number>();
  private readonly debt = new Set<string>();
  private readonly debtQueue: string[] = [];
  private accountCursor = 0;
  private debtCursor = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private closed = false;

  constructor(private readonly callbacks: Callbacks, private readonly maxDuePerTurn = 256) {}

  count(): number { return this.timer || this.running ? 1 : 0; }
  hasDebt(): boolean { return this.debt.size > 0; }
  trackedAccountCount(): number { return this.accounts.length; }
  debtCount(): number { return this.debt.size; }
  debtStorageCount(): number { return this.debtQueue.length; }
  dueStorageCount(): number { return this.heap.size(); }

  wake(): void { this.schedule(); }

  refresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.schedule();
  }

  trackAccount(accountId: string, cap: number): boolean {
    if (this.accountIndex.has(accountId)) return true;
    if (this.accounts.length >= cap) return false;
    this.accountIndex.set(accountId, this.accounts.length);
    this.accounts.push(accountId);
    return true;
  }

  releaseAccount(accountId: string): void {
    if (this.debt.has(accountId)) return;
    const index = this.accountIndex.get(accountId);
    if (index === undefined) return;
    const tail = this.accounts.pop()!;
    this.accountIndex.delete(accountId);
    if (index < this.accounts.length) {
      this.accounts[index] = tail;
      this.accountIndex.set(tail, index);
    }
    this.accountCursor = this.accounts.length === 0 ? 0 : this.accountCursor % this.accounts.length;
  }

  arm(work: AdmissionDueWork): void {
    if (this.closed) return;
    this.dueByAggregate.set(work.aggregateId, work);
    this.heap.push(work);
    if (this.heap.size() > this.dueByAggregate.size * 2 + 32) {
      this.heap.clear();
      for (const current of this.dueByAggregate.values()) this.heap.push(current);
    }
    this.schedule();
  }

  cancel(aggregateId: string): void {
    this.dueByAggregate.delete(aggregateId);
    this.refresh();
  }

  markDebt(accountId: string): void {
    if (this.closed) return;
    if (!this.debt.has(accountId)) {
      this.debt.add(accountId);
      this.debtQueue.push(accountId);
    }
    this.schedule();
  }

  clearDebt(accountId: string): void {
    if (this.closed) return;
    this.debt.delete(accountId);
    if (this.debtQueue.length > this.debt.size * 2 + 32) {
      this.debtQueue.splice(0, this.debtQueue.length, ...this.debt);
      this.debtCursor = 0;
    }
    if (this.debt.size === 0) {
      this.debtQueue.length = 0;
      this.debtCursor = 0;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.heap.clear();
    this.dueByAggregate.clear();
    this.accounts.length = 0;
    this.accountIndex.clear();
    this.debt.clear();
    this.debtQueue.length = 0;
  }

  private schedule(): void {
    if (this.closed || this.timer || this.running) return;
    const due = this.nextDue();
    if (this.debt.size === 0 && due === undefined) return;
    const delay = this.debt.size > 0 ? 25 : Math.max(0, due! - this.callbacks.now());
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, delay);
  }

  private async tick(): Promise<void> {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      const dueBeforeSweep = this.nextDue();
      if (this.debt.size > 0) {
        const account = this.nextDebtAccount();
        if (account) {
          const result = await this.callbacks.sweep(account);
          if (result.hasMore) this.markDebt(account);
          else this.clearDebt(account);
        }
        if ((dueBeforeSweep ?? Number.POSITIVE_INFINITY) > this.callbacks.now()) return;
      } else {
        const account = this.nextAccount();
        if (account) {
          const result = await this.callbacks.sweep(account);
          if (result.hasMore) this.markDebt(account);
          else this.clearDebt(account);
        }
      }
      const due: AdmissionDueWork[] = [];
      const now = this.callbacks.now();
      while (due.length < this.maxDuePerTurn) {
        const next = this.takeDue(now);
        if (!next) break;
        due.push(next);
      }
      if (due.length) await this.callbacks.renew(due);
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  private nextDue(): number | undefined {
    while (this.heap.peek()) {
      const work = this.heap.peek()!;
      const current = this.dueByAggregate.get(work.aggregateId);
      if (current === work && this.callbacks.isCurrent(work)) return work.dueAtMs;
      if (current === work) this.dueByAggregate.delete(work.aggregateId);
      this.heap.pop();
    }
    return undefined;
  }

  private takeDue(now: number): AdmissionDueWork | undefined {
    const due = this.nextDue();
    if (due === undefined || due > now) return undefined;
    const work = this.heap.pop();
    if (work && this.dueByAggregate.get(work.aggregateId) === work) this.dueByAggregate.delete(work.aggregateId);
    return work;
  }

  private nextAccount(): string | undefined {
    if (this.accounts.length === 0) return undefined;
    const account = this.accounts[this.accountCursor % this.accounts.length];
    this.accountCursor = (this.accountCursor + 1) % this.accounts.length;
    return account;
  }

  private nextDebtAccount(): string | undefined {
    while (this.debtQueue.length) {
      if (this.debtCursor >= this.debtQueue.length) this.debtCursor = 0;
      const account = this.debtQueue[this.debtCursor++];
      if (this.debt.has(account)) return account;
    }
    return undefined;
  }
}
