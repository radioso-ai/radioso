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
    expect(safeErrorFields(null)).toEqual({ name: "null" });
  });

  it("keeps the uppercase errno and library codes an outage is diagnosed by", () => {
    for (const code of ["ECONNREFUSED", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "ERR_INVALID_ARG_TYPE"]) {
      const error = Object.assign(new Error(`connect ${code} 10.0.0.4:5432 for ${visitorWords}`), { code });
      expect(safeErrorFields(error).code).toBe(code);
    }
  });

  it("keeps a Postgres SQLSTATE code", () => {
    for (const code of ["23505", "42P01", "57P01"]) {
      const error = Object.assign(new Error(`duplicate key value violates unique constraint: ${visitorWords}`), { code });
      expect(safeErrorFields(error).code).toBe(code);
    }
  });

  it("keeps a numeric code and an HTTP status, and drops either when it is not a plain number", () => {
    const provider = Object.assign(new Error(visitorWords), { status: 429, code: 8 });
    expect(safeErrorFields(provider)).toMatchObject({ code: 8, status: 429 });

    const gateway = Object.assign(new Error(visitorWords), { statusCode: 503 });
    expect(safeErrorFields(gateway).status).toBe(503);

    const malformed = Object.assign(new Error(visitorWords), { status: `failed for ${visitorWords}`, code: Number.NaN });
    expect(safeErrorFields(malformed)).not.toHaveProperty("status");
    expect(safeErrorFields(malformed)).not.toHaveProperty("code");
    expect(safeErrorFields(Object.assign(new Error("x"), { status: 15551234567 }))).not.toHaveProperty("status");
  });

  it("drops an uppercase code that carries more than a code", () => {
    const error = Object.assign(new Error("ignored"), { code: "CONTACT JANE@EXAMPLE.COM" });
    expect(safeErrorFields(error)).not.toHaveProperty("code");
  });

  it("follows a cause for its class and code, never its message", () => {
    const socketError = Object.assign(new Error(`connect ECONNREFUSED for ${visitorWords}`), { code: "ECONNREFUSED" });
    const fetchFailure = new TypeError("fetch failed", { cause: socketError });

    const fields = safeErrorFields(fetchFailure);

    expect(fields).toMatchObject({ name: "TypeError", cause: { name: "Error", code: "ECONNREFUSED" } });
    expect(JSON.stringify(fields)).not.toContain(visitorWords);
    expect(JSON.stringify(fields)).not.toContain("connect ECONNREFUSED");
  });

  it("reads a thrown plain object's code and status but nothing else it carries", () => {
    const fields = safeErrorFields({ code: "ECONNRESET", status: 502, message: visitorWords, name: "jane" });

    expect(fields).toEqual({ name: "object", code: "ECONNRESET", status: 502 });
  });

  it("stops following causes after a bounded depth, and on a cycle", () => {
    let chain: Error = Object.assign(new Error(visitorWords), { code: "E_DEEPEST" });
    for (let depth = 0; depth < 10; depth += 1) {
      chain = new Error(visitorWords, { cause: chain });
    }
    const depthOf = (fields: { cause?: unknown }): number =>
      fields.cause && typeof fields.cause === "object" ? 1 + depthOf(fields.cause) : 0;
    expect(depthOf(safeErrorFields(chain))).toBe(3);

    const cyclic = new Error(visitorWords);
    (cyclic as { cause?: unknown }).cause = cyclic;
    expect(depthOf(safeErrorFields(cyclic))).toBeLessThanOrEqual(3);
    expect(JSON.stringify(safeErrorFields(chain))).not.toContain(visitorWords);
  });

  it("never throws on a caught value whose properties throw when read", () => {
    const hostile = new Error(visitorWords);
    for (const property of ["cause", "code", "status", "name", "stack"]) {
      Object.defineProperty(hostile, property, {
        get: () => {
          throw new Error(`getter for ${visitorWords}`);
        },
      });
    }
    const plain = Object.defineProperty({}, "cause", {
      get: () => {
        throw new Error("cause getter");
      },
    });

    expect(() => safeErrorFields(hostile)).not.toThrow();
    expect(safeErrorFields(hostile)).toEqual({ name: "Error" });
    expect(safeErrorFields(plain)).toEqual({ name: "object" });
  });
});
