/**
 * How many photos this process decodes at once, with a short wait for a free slot. Decoding runs
 * on libuv's thread pool, which dns, fs and zlib share, so a burst of uploads must not take all of
 * it; work that waits past `waitMs` is refused as `busy` instead of queueing without end.
 */
export class NormalizationSlots {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly waitMs: number,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T | "busy"> {
    if (!await this.acquire()) return "busy";
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<boolean> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      // A freed slot passes straight to the next waiter, so `active` stays where it is.
      const grant = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(grant), 1);
        resolve(false);
      }, this.waitMs);
      this.waiting.push(grant);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }
}
