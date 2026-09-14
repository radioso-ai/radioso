import { describe, expect, it } from "vitest";

import { extractExceptionDiagnostics } from "../../../src/modules/appStorage/domain/diagnostics.js";
import { connectionFailure, statementFailure } from "./repositoryStub.js";

describe("app storage exception diagnostics", () => {
  it("never carries a pg error's detail, hint, or message — they embed the value that failed", () => {
    const error = statementFailure();
    const fields = extractExceptionDiagnostics(error);

    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain("customer-secret");
    expect(serialized).not.toContain("Failing row");
    expect(fields).not.toHaveProperty("detail");
    expect(fields).not.toHaveProperty("hint");
    expect(fields).not.toHaveProperty("message");
  });

  it("carries the SQLSTATE a pg error reports as `code`", () => {
    expect(extractExceptionDiagnostics(statementFailure()).sqlState).toBe("23502");
  });

  it("names null rather than guessing when the driver reports no SQLSTATE", () => {
    expect(extractExceptionDiagnostics(new Error("boom")).sqlState).toBeNull();
  });

  it("carries a constraint name when the driver names one", () => {
    const error = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "app_storage_records_pkey",
    });
    expect(extractExceptionDiagnostics(error).constraint).toBe("app_storage_records_pkey");
  });

  it("names null rather than a value when no constraint is present", () => {
    expect(extractExceptionDiagnostics(connectionFailure()).constraint).toBeNull();
  });

  it("names the exception's own class, including a custom one", () => {
    expect(extractExceptionDiagnostics(statementFailure()).exceptionClass).toBe("Error");

    class CustomStorageFailure extends Error {}
    expect(extractExceptionDiagnostics(new CustomStorageFailure("x")).exceptionClass).toBe(
      "CustomStorageFailure",
    );
  });

  it("names a thrown non-Error value by its type rather than failing to extract anything", () => {
    expect(extractExceptionDiagnostics("not an error").exceptionClass).toBe("string");
    expect(extractExceptionDiagnostics(null).exceptionClass).toBe("object");
  });

  it("carries a stack for an Error, and null for a throw that has none", () => {
    expect(typeof extractExceptionDiagnostics(new Error("x")).stack).toBe("string");
    expect(extractExceptionDiagnostics("not an error").stack).toBeNull();
  });

  it("keeps the frames of a stack but not its first line, which repeats the message", () => {
    const error = new Error('invalid input syntax for type uuid: "customer-secret"');
    const { stack } = extractExceptionDiagnostics(error);
    expect(stack).not.toContain("customer-secret");
    expect(stack).toContain("at ");
  });
});
