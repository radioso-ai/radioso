import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { sendSseIterable, writeSseEvent } from "../../src/app/http/presenters/ssePresenter.js";

class BackpressuredResponse extends EventEmitter {
  headersSent = true;
  writableEnded = false;
  readonly writes: string[] = [];
  #blockNextWrite = true;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    if (this.#blockNextWrite) {
      this.#blockNextWrite = false;
      return false;
    }
    return true;
  }

  end(): void {
    this.writableEnded = true;
  }
}

describe("SSE presenter", () => {
  it("waits for response drain before consuming and writing the next frame", async () => {
    const response = new BackpressuredResponse();
    let yielded = 0;
    const sending = sendSseIterable(response as never, (async function* () {
      yielded += 1;
      yield 1;
      yielded += 1;
      yield 2;
    })(), (value) => writeSseEvent(response as never, "push", { value }));

    await vi.waitFor(() => expect(response.writes).toEqual(["event: push\n"]));
    expect(yielded).toBe(1);

    response.emit("drain");
    await sending;

    expect(yielded).toBe(2);
    expect(response.writes.join("")).toContain('data: {"value":2}\n\n');
    expect(response.writableEnded).toBe(true);
  });
});
