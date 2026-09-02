import { describe, expect, it, vi } from "vitest";

import { AuditService } from "../../../src/modules/audit/services/auditService.js";
import {
  runWithRequestAuditContext,
  setRequestAuditPrincipal,
} from "../../../src/modules/audit/requestAuditContext.js";

describe("request audit attribution", () => {
  it("adds request correlation and the resolved API principal to audited actions", async () => {
    const repository = { create: vi.fn().mockResolvedValue(undefined) };
    const logger = { info: vi.fn() };
    const audit = new AuditService(logger as never, repository as never);

    await runWithRequestAuditContext({ requestId: "request-1" }, async () => {
      setRequestAuditPrincipal({
        credentialId: "credential-1",
        principalId: "service-account-1",
        principalKind: "service",
        role: "member",
      });
      await audit.record({
        accountId: "account-1",
        workspaceId: "workspace-1",
        eventType: "document.search",
        eventStatus: "success",
        metadata: { queryMode: "hybrid" },
      });
    });

    expect(repository.create).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: "workspace-1",
      eventType: "document.search",
      eventStatus: "success",
      metadata: {
        credentialId: "credential-1",
        principalId: "service-account-1",
        principalKind: "service",
        queryMode: "hybrid",
        requestId: "request-1",
        role: "member",
      },
    });
  });

  it("does not leak request attribution outside its async request scope", async () => {
    const repository = { create: vi.fn().mockResolvedValue(undefined) };
    const audit = new AuditService({ info: vi.fn() } as never, repository as never);

    await runWithRequestAuditContext({ requestId: "request-1" }, async () => {
      setRequestAuditPrincipal({
        credentialId: "credential-1",
        principalId: "user-1",
        principalKind: "user",
        role: "admin",
      });
    });
    await audit.record({ eventType: "outside.request", eventStatus: "success" });

    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ metadata: undefined }));
  });
});
