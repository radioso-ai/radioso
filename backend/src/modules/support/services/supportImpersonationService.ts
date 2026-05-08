import { forbidden, notFound, unauthorized } from "../../../shared/domain/errors.js";
import type { Env } from "../../../app/config/env.js";
import type { UserRepositoryPort } from "../../../db/repositories/userRepository.js";
import type {
  SupportImpersonationRecord,
  SupportImpersonationRepositoryPort,
} from "../../../db/repositories/supportImpersonationRepository.js";
import type { AuditService } from "../../audit/contracts/index.js";

const SUPPORT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface SupportImpersonationSummary {
  id: string;
  accountId: string;
  staffUserId: string;
  approverUserId: string;
  reason: string;
  status: SupportImpersonationRecord["status"];
  approvedAt: string;
  startedAt: string | null;
  expiresAt: string;
  endedAt: string | null;
  active: boolean;
}

const serialize = (record: SupportImpersonationRecord, now = new Date()): SupportImpersonationSummary => ({
  id: record.id,
  accountId: record.accountId,
  staffUserId: record.staffUserId,
  approverUserId: record.approverUserId,
  reason: record.reason,
  status: record.status,
  approvedAt: record.approvedAt.toISOString(),
  startedAt: record.startedAt?.toISOString() ?? null,
  expiresAt: record.expiresAt.toISOString(),
  endedAt: record.endedAt?.toISOString() ?? null,
  active: record.status === "active" && record.expiresAt.getTime() > now.getTime() && !record.endedAt,
});

export class SupportImpersonationService {
  constructor(
    private readonly repository: SupportImpersonationRepositoryPort,
    private readonly userRepository: UserRepositoryPort,
    private readonly auditService: AuditService,
    private readonly env: Pick<Env, "SUPPORT_STAFF_EMAILS">,
  ) {}

  async approve(input: {
    accountId: string;
    staffUserId: string;
    approverUserId: string;
    reason: string;
  }): Promise<SupportImpersonationSummary> {
    await this.requireSupportStaff(input.approverUserId);
    await this.requireSupportStaff(input.staffUserId);
    if (input.approverUserId === input.staffUserId) {
      throw forbidden("Support impersonation requires approval from another support staff user");
    }
    const reason = input.reason.trim();
    if (!reason) {
      throw forbidden("Support impersonation requires a reason");
    }

    const record = await this.repository.createApproved({
      accountId: input.accountId,
      staffUserId: input.staffUserId,
      approverUserId: input.approverUserId,
      reason,
      expiresAt: new Date(Date.now() + SUPPORT_SESSION_TTL_MS),
    });
    await this.auditService.record({
      accountId: input.accountId,
      eventType: "support.impersonation.approve",
      eventStatus: "success",
      metadata: {
        staffUserId: input.staffUserId,
        approverUserId: input.approverUserId,
        supportImpersonationId: record.id,
        reason,
      },
    });

    return serialize(record);
  }

  async start(input: { id: string; staffUserId: string }): Promise<SupportImpersonationSummary> {
    const record = await this.requireUsable(input.id, input.staffUserId);
    const started = record.status === "active" ? record : await this.repository.markStarted(record.id, new Date());
    await this.auditService.record({
      accountId: started.accountId,
      eventType: "support.impersonation.start",
      eventStatus: "success",
      metadata: {
        staffUserId: input.staffUserId,
        supportImpersonationId: started.id,
      },
    });

    return serialize(started);
  }

  async end(input: { id: string; staffUserId: string }): Promise<SupportImpersonationSummary> {
    const record = await this.repository.findById(input.id);
    if (!record || record.staffUserId !== input.staffUserId) {
      throw notFound("Support impersonation session not found");
    }
    const ended = await this.repository.end(record.id, "ended", new Date());
    await this.auditService.record({
      accountId: ended.accountId,
      eventType: "support.impersonation.end",
      eventStatus: "success",
      metadata: {
        staffUserId: input.staffUserId,
        supportImpersonationId: ended.id,
      },
    });

    return serialize(ended);
  }

  async listForAccount(accountId: string): Promise<SupportImpersonationSummary[]> {
    const now = new Date();
    const records = await this.repository.listByAccount(accountId, now);
    return records.map((record) => serialize(record, now));
  }

  async authenticateActive(input: {
    id: string;
    staffUserId: string;
  }): Promise<SupportImpersonationRecord> {
    const record = await this.requireUsable(input.id, input.staffUserId);
    if (record.status !== "active") {
      throw forbidden("Support impersonation session has not been started");
    }
    return record;
  }

  async requireSupportStaff(userId: string): Promise<void> {
    const user = await this.userRepository.findById(userId);
    const allowlist = this.env.SUPPORT_STAFF_EMAILS
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
    if (!user || !allowlist.includes(user.email.toLowerCase())) {
      throw unauthorized("Support staff access is required");
    }
  }

  private async requireUsable(id: string, staffUserId: string): Promise<SupportImpersonationRecord> {
    await this.requireSupportStaff(staffUserId);
    const record = await this.repository.findById(id);
    if (!record || record.staffUserId !== staffUserId) {
      throw notFound("Support impersonation session not found");
    }
    if (record.endedAt || record.status === "ended" || record.status === "revoked") {
      throw forbidden("Support impersonation session is no longer active");
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      await this.repository.end(record.id, "expired", new Date());
      throw forbidden("Support impersonation session has expired");
    }

    return record;
  }
}
