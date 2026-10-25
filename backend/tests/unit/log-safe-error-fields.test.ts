import { describe, expect, it } from "vitest";

import { safeErrorFields } from "../../src/shared/observability/logging/logSafeValues.js";

const visitorWords = "my daughter has asthma and needs the ground floor room";

class CodedError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "CodedError";
    this.code = code;
  }
}

describe("safeErrorFields", () => {
  it("keeps an error's class but never its message", () => {
    const fields = safeErrorFields(new TypeError(`Could not parse "${visitorWords}"`));

    expect(fields.name).toBe("TypeError");
    expect(JSON.stringify(fields)).not.toContain(visitorWords);
  });

  it("drops the stack's first line, which restates the message, and keeps only real frames", () => {
    const error = new Error(visitorWords);
    error.stack = [
      `Error: ${visitorWords}`,
      "    at handler (/app/dist/index.js:1:2)",
      `    at ${visitorWords}`,
    ].join("\n");

    const fields = safeErrorFields(error);

    expect(fields.stack).toBe("    at handler (/app/dist/index.js:1:2)");
    expect(fields.stack).not.toContain(visitorWords);
  });

  it("keeps a structural error code but never a provider's free-text one", () => {
    const coded = safeErrorFields(new CodedError("ignored", "not_found"));
    expect(coded.code).toBe("not_found");

    const freeText = new CodedError("ignored", `provider said: ${visitorWords}`);
    const uncoded = safeErrorFields(freeText);
    expect(uncoded.code).toBeUndefined();
    expect(JSON.stringify(uncoded)).not.toContain(visitorWords);
  });

  it("never follows a cause into its message", () => {
    const withCause = new Error("outer", { cause: new Error(visitorWords) });
    const fields = safeErrorFields(withCause);
    expect(JSON.stringify(fields)).not.toContain(visitorWords);
  });

  it("names the JS type of a thrown non-error value without echoing its content", () => {
    expect(safeErrorFields(visitorWords)).toEqual({ name: "string" });
    expect(safeErrorFields(undefined)).toEqual({ name: "undefined" });
  });
});
