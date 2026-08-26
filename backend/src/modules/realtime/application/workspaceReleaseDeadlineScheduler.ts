export type MonotonicClock = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

type Deadline<T> = { dueAtMs: number; key: string; value: T };

/** The gateway owns one timer; this heap avoids a timer per releasing workspace. */
export class WorkspaceReleaseDeadlineScheduler<T> {
  private readonly heap: Deadline<T>[] = [];
  private readonly indices = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly clock: MonotonicClock,
    private readonly onDue: (value: T) => void,
  ) {}

  schedule(key: string, value: T, dueAtMs: number): void {
    const deadline = { dueAtMs, key, value };
    const existingIndex = this.indices.get(key);
    if (existingIndex !== undefined) {
      this.heap[existingIndex] = deadline;
      this.rebalance(existingIndex);
      this.arm();
      return;
    }
    this.push(deadline);
    this.arm();
  }

  cancel(key: string): void {
    const index = this.indices.get(key);
    if (index === undefined) return;
    this.removeAt(index);
    this.arm();
  }

  clear(): void {
    this.heap.length = 0;
    this.indices.clear();
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Bounded by active releasing workspaces because every key is indexed once. */
  size(): number {
    return this.heap.length;
  }

  private arm(): void {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    const next = this.heap[0];
    if (!next) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.flushDue();
    }, Math.max(0, next.dueAtMs - this.clock.now()));
  }

  private flushDue(): void {
    const now = this.clock.now();
    while (this.heap[0]?.dueAtMs <= now) {
      const deadline = this.removeAt(0)!;
      this.onDue(deadline.value);
    }
    this.arm();
  }

  private push(value: Deadline<T>): void {
    this.heap.push(value);
    let index = this.heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.heap[parent]!.dueAtMs <= value.dueAtMs) break;
      this.heap[index] = this.heap[parent]!;
      this.indices.set(this.heap[index]!.key, index);
      index = parent;
    }
    this.heap[index] = value;
    this.indices.set(value.key, index);
  }

  private removeAt(index: number): Deadline<T> | undefined {
    const first = this.heap[index];
    const tail = this.heap.pop();
    if (!first || !tail) return first;
    this.indices.delete(first.key);
    if (index === this.heap.length) return first;
    this.heap[index] = tail;
    this.indices.set(tail.key, index);
    this.rebalance(index);
    return first;
  }

  private rebalance(index: number): void {
    const value = this.heap[index]!;
    const parent = Math.floor((index - 1) / 2);
    if (index > 0 && this.heap[parent]!.dueAtMs > value.dueAtMs) {
      this.siftUp(index, value);
      return;
    }
    this.siftDown(index, value);
  }

  private siftUp(index: number, value: Deadline<T>): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.heap[parent]!.dueAtMs <= value.dueAtMs) break;
      this.heap[index] = this.heap[parent]!;
      this.indices.set(this.heap[index]!.key, index);
      index = parent;
    }
    this.heap[index] = value;
    this.indices.set(value.key, index);
  }

  private siftDown(index: number, value: Deadline<T>): void {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.heap.length) break;
      const child = right < this.heap.length && this.heap[right]!.dueAtMs < this.heap[left]!.dueAtMs ? right : left;
      if (this.heap[child]!.dueAtMs >= value.dueAtMs) break;
      this.heap[index] = this.heap[child]!;
      this.indices.set(this.heap[index]!.key, index);
      index = child;
    }
    this.heap[index] = value;
    this.indices.set(value.key, index);
  }
}

export const systemMonotonicClock: MonotonicClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};
