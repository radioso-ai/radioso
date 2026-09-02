import { describe, expect, it } from "vitest";

import { machineAccessAuditMetadata } from "../../../src/modules/machineAccess/auditMetadata.js";

describe("machine-access audit metadata", () => {
  it("allows bounded lifecycle identifiers and facts", () => {
    expect(machineAccessAuditMetadata({
      actorUserId: "user-1",
      credentialId: "credential-1",
      principalKind: "user",
      principalId: "user-1",
      reason: "membership_ended",
      systemInitiated: false,
    })).toEqual(expect.objectContaining({ credentialId: "credential-1" }));
  });

  it("rejects secret-bearing and undeclared metadata keys", () => {
    expect(() => machineAccessAuditMetadata({ secret: "radioso_pat_v1_should_not_log" })).toThrow(/Unexpected|Secret-bearing/);
    expect(() => machineAccessAuditMetadata({ tokenHash: "never-audit" })).toThrow(/Unexpected|Secret-bearing/);
  });
});
