import { afterEach, describe, expect, it, vi } from "vitest";

import { sendTestExecutionSse } from "../../src/app/http/presenters/testExecutionPresenter.js";
import type { TestExecutionEvent } from "../../src/modules/test-execution/testExecution.js";

const createMockResponse = () => {
  let closeHandler: (() => void) | undefined;
  const writes: string[] = [];
  const response = {
    destroyed: false,
    headersSent: false,
    writableEnded: false,
    on(event: string, handler: () => void) {
      if (event === "close") closeHandler = handler;
    },
    status() { return this; },
    setHeader() { return this; },
    flushHeaders() { this.headersSent = true; },
    write(chunk: string) { writes.push(chunk); },
    end() { this.writableEnded = true; },
  };
  return { response, writes, close: () => closeHandler?.() };
};

describe("test execution SSE presenter disconnect ceiling", () => {
  afterEach(() => vi.useRealTimers());

  it("aborts and releases a Test Chat stream that stays blocked after disconnect", async () => {
    vi.useFakeTimers();
    const { response, close } = createMockResponse();
    const iteratorReturn = vi.fn(async () => ({ value: undefined, done: true as const }));
    const events: AsyncIterable<TestExecutionEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next: vi.fn(() => new Promise<IteratorResult<TestExecutionEvent>>(() => undefined)),
          return: iteratorReturn,
        };
      },
    };
    const onDisconnectCeilingExceeded = vi.fn();

    const sending = sendTestExecutionSse(response as never, events, {
      onDisconnectCeilingExceeded,
    });
    close();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(120_000);
    await sending;

    expect(onDisconnectCeilingExceeded).toHaveBeenCalledOnce();
    expect(iteratorReturn).toHaveBeenCalledOnce();
    expect(response.headersSent).toBe(false);
  });
});
