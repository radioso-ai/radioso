import { describe, expect, it } from "vitest";

import { reportStorageFailure } from "../../../src/modules/appStorage/services/appStorageDiagnosticsReporting.js";
import {
  AppStorageExportBusyError,
  AppStorageExportClosedError,
} from "../../../src/modules/appStorage/domain/results.js";
import { buildDiagnosticsStub as buildDiagnostics, connectionFailure, statementFailure } from "./repositoryStub.js";

describe("app storage failure reporting", () => {
  it("records identifiers, classification, and the exception's safe facts for an internal failure", () => {
    const diagnostics = buildDiagnostics();
    const error = statementFailure();

    const result = reportStorageFailure(diagnostics, "put", { workspaceId: "w1", collectionId: "c1" }, error);

    expect(result).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(diagnostics.failure).toHaveBeenCalledTimes(1);
    const [fields, message] = diagnostics.failure.mock.calls[0] ?? [];
    expect(fields).toMatchObject({
      operation: "put",
      workspaceId: "w1",
      collectionId: "c1",
      classification: "internal",
      exceptionClass: "Error",
      sqlState: "23502",
    });
    expect(typeof message).toBe("string");
  });

  it("records an unavailable classification the same way", () => {
    const diagnostics = buildDiagnostics();

    reportStorageFailure(diagnostics, "get", {}, connectionFailure());

    expect(diagnostics.failure).toHaveBeenCalledWith(
      expect.objectContaining({ classification: "unavailable" }),
      expect.any(String),
    );
  });

  it("never records a record key, a stored value, or the driver's own message text", () => {
    const diagnostics = buildDiagnostics();

    reportStorageFailure(diagnostics, "put", {}, statementFailure());

    const [fields, message] = diagnostics.failure.mock.calls[0] ?? [];
    const serialized = JSON.stringify(fields) + message;
    expect(serialized).not.toContain("customer-secret");
    expect(serialized).not.toContain("Failing row");
    expect(fields).not.toHaveProperty("detail");
    expect(fields).not.toHaveProperty("hint");
  });

  it("does not report a second reader refused a busy export snapshot", () => {
    const diagnostics = buildDiagnostics();

    // A caller error with a name of its own, not a cause an operator has to
    // diagnose — the classification already says what happened.
    const result = reportStorageFailure(diagnostics, "export", {}, new AppStorageExportBusyError());

    expect(result.ok).toBe(false);
    expect(diagnostics.failure).not.toHaveBeenCalled();
  });

  it("does not report a snapshot that closed out from under an export", () => {
    const diagnostics = buildDiagnostics();

    // `unavailable` here names an idle timeout or an explicit close, already
    // fully explained by the classification — not a mystery to diagnose.
    reportStorageFailure(diagnostics, "export", {}, new AppStorageExportClosedError());

    expect(diagnostics.failure).not.toHaveBeenCalled();
  });
});
