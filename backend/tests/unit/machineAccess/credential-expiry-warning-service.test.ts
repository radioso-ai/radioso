import { afterEach, describe, expect, it, vi } from "vitest";

import { CredentialExpiryWarningService } from "../../../src/modules/machineAccess/services/credentialExpiryWarningService.js";

const claim = {
  credentialId: "credential-1",
  workspaceId: "workspace-1",
  accountId: "account-1",
  principalKind: "user" as const,
  principalId: "user-1",
  thresholdDays: 7 as const,
  expiresAt: new Date("2026-09-07T00:00:00.000Z"),
};

const createService = (overrides: Record<string, unknown> = {}) => {
  const repository = {
    claimExpiryWarnings: vi.fn().mockResolvedValue([claim]),
    releaseExpiryWarning: vi.fn().mockResolvedValue(undefined),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const logger = { warn: vi.fn() };
  const service = new CredentialExpiryWarningService({
    repository,
    audit,
    logger,
    now: () => new Date("2026-08-31T00:00:00.000Z"),
    ...overrides,
  });
  return { audit, logger, repository, service };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("CredentialExpiryWarningService", () => {
  it("records a durable audit event for each newly claimed threshold", async () => {
    const { audit, repository, service } = createService();

    await service.runOnce();

    expect(repository.claimExpiryWarnings).toHaveBeenCalledWith(new Date("2026-08-31T00:00:00.000Z"));
    expect(audit.record).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: "workspace-1",
      eventType: "machine_access.credential.expiry_warning",
      eventStatus: "success",
      metadata: {
        credentialId: "credential-1",
        expiresAt: "2026-09-07T00:00:00.000Z",
        principalId: "user-1",
        principalKind: "user",
        thresholdDays: 7,
      },
    });
    expect(repository.releaseExpiryWarning).not.toHaveBeenCalled();
  });

  it("releases a claim when audit persistence fails so a later scan can retry", async () => {
    const { audit, logger, repository, service } = createService();
    audit.record.mockRejectedValueOnce(new Error("audit unavailable"));

    await service.runOnce();

    expect(repository.releaseExpiryWarning).toHaveBeenCalledWith("credential-1", 7);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: "credential-1", thresholdDays: 7 }),
      "Credential expiry warning audit failed",
    );
  });

  it("runs immediately, schedules daily scans, and stops cleanly", async () => {
    vi.useFakeTimers();
    const { repository, service } = createService();

    await service.start();
    expect(repository.claimExpiryWarnings).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(repository.claimExpiryWarnings).toHaveBeenCalledTimes(2);

    await service.stop();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(repository.claimExpiryWarnings).toHaveBeenCalledTimes(2);
  });
});
