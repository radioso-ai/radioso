export type DueItem = { dueAtMs: number };

/** Small binary min-heap for a single monotonic scheduler. */
export class MonotonicDueHeap<T extends DueItem> {
  private readonly values: T[] = [];

  peek(): T | undefined {
    return this.values[0];
  }

  push(value: T): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent]!.dueAtMs <= value.dueAtMs) break;
      this.values[index] = this.values[parent]!;
      index = parent;
    }
    this.values[index] = value;
  }

  pop(): T | undefined {
    const first = this.values[0];
    const tail = this.values.pop();
    if (!first || !tail || this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.values.length) break;
      const child = right < this.values.length && this.values[right]!.dueAtMs < this.values[left]!.dueAtMs ? right : left;
      if (this.values[child]!.dueAtMs >= tail.dueAtMs) break;
      this.values[index] = this.values[child]!;
      index = child;
    }
    this.values[index] = tail;
    return first;
  }

  clear(): void {
    this.values.length = 0;
  }

  size(): number { return this.values.length; }
}
