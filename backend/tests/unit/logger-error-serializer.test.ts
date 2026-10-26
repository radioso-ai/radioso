import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { createLogger } from "../../src/shared/observability/logger.js";

const visitorWords = "my daughter has asthma and needs the ground floor room";

const captureLines = (): { logger: ReturnType<typeof createLogger>; lines: () => Record<string, unknown>[] } => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    logger: createLogger("debug", stream),
    lines: () => chunks.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
  };
};

class CodedError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "CodedError";
    this.code = code;
  }
}

describe("app logger error serializer", () => {
  it("keeps an err value's class and shape-checked frames but drops the message", () => {
    const { logger, lines } = captureLines();

    logger.error(
      { err: new TypeError(`Could not reach the provider for "${visitorWords}"`), workspaceId: "workspace-1" },
      "provider call failed",
    );

    const [line] = lines();
    expect(JSON.stringify(line)).not.toContain(visitorWords);
    expect(line?.err).toMatchObject({ name: "TypeError" });
    expect(line?.workspaceId).toBe("workspace-1");
  });

  it("applies the same serializer to an `error` key", () => {
    const { logger, lines } = captureLines();

    logger.warn({ error: new Error(`visitor said: ${visitorWords}`) }, "job tick failed");

    const [line] = lines();
    expect(JSON.stringify(line)).not.toContain(visitorWords);
    expect(line?.error).toMatchObject({ name: "Error" });
  });

  it("keeps a structural error code", () => {
    const { logger, lines } = captureLines();

    logger.error({ err: new CodedError("ignored", "not_found") }, "lookup failed");

    const [line] = lines();
    expect(line?.err).toMatchObject({ name: "CodedError", code: "not_found" });
  });

  it("names a non-error value's type rather than echoing it", () => {
    const { logger, lines } = captureLines();

    logger.error({ err: `rejected: ${visitorWords}` }, "unhandled rejection");

    const [line] = lines();
    expect(JSON.stringify(line)).not.toContain(visitorWords);
    expect(line?.err).toMatchObject({ name: "string" });
  });

  it("never lets pino fill a missing message from the error's own", () => {
    const { logger, lines } = captureLines();

    // pino writes `err.message` as the line's `msg` when a call passes an error and no message.
    logger.error(new TypeError(`Could not book "${visitorWords}"`));
    logger.error({ err: new Error(`provider said: ${visitorWords}`), workspaceId: "workspace-1" });
    logger.warn({ error: new Error(`visitor said: ${visitorWords}`) });

    const logged = lines();
    expect(logged).toHaveLength(3);
    expect(JSON.stringify(logged)).not.toContain(visitorWords);
    expect(logged.map((line) => line.msg)).toEqual(["TypeError", "Error", "Error"]);
    expect(logged[1]).toMatchObject({ workspaceId: "workspace-1", err: { name: "Error" } });
  });

  it("never lets pino fill a missing message from a non-Error err's own message", () => {
    const { logger, lines } = captureLines();

    // pino reads `obj.err.message` whenever `err` is truthy, whatever it is.
    logger.error({ err: { message: `provider said: ${visitorWords}`, code: "ECONNRESET" } });

    const [line] = lines();
    expect(JSON.stringify(line)).not.toContain(visitorWords);
    expect(line).toMatchObject({ msg: "object", err: { name: "object", code: "ECONNRESET" } });
  });

  it("leaves a call's own message alone", () => {
    const { logger, lines } = captureLines();

    logger.error(new TypeError("ignored"), "booking failed");
    logger.info({ workspaceId: "workspace-1" });

    expect(lines().map((line) => line.msg)).toEqual(["booking failed", undefined]);
  });
});
