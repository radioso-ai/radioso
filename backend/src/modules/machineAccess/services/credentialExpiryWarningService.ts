import type {
  CredentialExpiryWarningClaim,
  MachineAccessPersistencePort,
} from "../ports.js";
import type { AuditService } from "../../audit/contracts/index.js";
import type { AppLogger } from "../../../shared/observability/logger.js";

const DAILY_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1_000;

type ExpiryWarningRepository = Pick<
  MachineAccessPersistencePort,
  "claimExpiryWarnings" | "releaseExpiryWarning"
>;

export class CredentialExpiryWarningService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanInProgress = false;

  constructor(private readonly input: {
    repository: ExpiryWarningRepository;
    audit: Pick<AuditService, "record">;
    logger: Pick<AppLogger, "warn">;
    now?: () => Date;
    intervalMs?: number;
  }) {}

  async runOnce(): Promise<void> {
    const claims = await this.input.repository.claimExpiryWarnings(
      (this.input.now ?? (() => new Date()))(),
    );
    for (const claim of claims) {
      await this.recordClaim(claim);
    }
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.runSafely();
    this.timer = setInterval(
      () => void this.runSafely(),
      this.input.intervalMs ?? DAILY_SCAN_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async runSafely(): Promise<void> {
    if (this.scanInProgress) return;
    this.scanInProgress = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.input.logger.warn({ err: error }, "Credential expiry warning scan failed");
    } finally {
      this.scanInProgress = false;
    }
  }

  private async recordClaim(claim: CredentialExpiryWarningClaim): Promise<void> {
    try {
      await this.input.audit.record({
        accountId: claim.accountId,
        workspaceId: claim.workspaceId,
        eventType: "machine_access.credential.expiry_warning",
        eventStatus: "success",
        metadata: {
          credentialId: claim.credentialId,
          expiresAt: claim.expiresAt.toISOString(),
          principalId: claim.principalId,
          principalKind: claim.principalKind,
          thresholdDays: claim.thresholdDays,
        },
      });
    } catch (error) {
      try {
        await this.input.repository.releaseExpiryWarning(
          claim.credentialId,
          claim.thresholdDays,
        );
      } catch (releaseError) {
        this.input.logger.warn({
          credentialId: claim.credentialId,
          err: releaseError,
          thresholdDays: claim.thresholdDays,
        }, "Credential expiry warning claim release failed");
      }
      this.input.logger.warn({
        credentialId: claim.credentialId,
        err: error,
        thresholdDays: claim.thresholdDays,
      }, "Credential expiry warning audit failed");
    }
  }
}
