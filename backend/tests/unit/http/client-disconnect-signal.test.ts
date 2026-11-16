import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { clientDisconnectSignal } from "../../../src/app/http/shared/clientDisconnectSignal.js";

type ClosingResponse = Parameters<typeof clientDisconnectSignal>[0] & { emit(event: "close"): boolean; writableEnded: boolean };

const response = (): ClosingResponse =>
  Object.assign(new EventEmitter(), { writableEnded: false }) as unknown as ClosingResponse;

describe("clientDisconnectSignal", () => {
  it("fires when the client goes away before the response ended", () => {
    const res = response();
    const signal = clientDisconnectSignal(res);

    res.emit("close");

    expect(signal.aborted).toBe(true);
  });

  it("stays quiet when the response finished and then closed", () => {
    const res = response();
    const signal = clientDisconnectSignal(res);

    res.writableEnded = true;
    res.emit("close");

    expect(signal.aborted).toBe(false);
  });
});
