/**
 * Events pushed by concurrently running producers, read back in arrival order. A producer never
 * waits for the reader, so a reader that stops early cannot stall the work pushing into the queue.
 */
interface LiveEventQueue<Event> {
  push(event: Event): void;
  /** Nothing more will be pushed: the reader ends once it has read what is buffered. */
  close(): void;
  read(): AsyncGenerator<Event>;
}

export const createLiveEventQueue = <Event>(): LiveEventQueue<Event> => {
  const buffered: Event[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  return {
    push(event) {
      if (closed) return;
      buffered.push(event);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
    async *read() {
      for (;;) {
        if (buffered.length > 0) {
          yield buffered.shift()!;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
  };
};
