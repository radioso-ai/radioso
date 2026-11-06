/**
 * The two things about staff access someone should hear about: sign-ins and changes to who holds
 * access. Each writes its audit record and one structured log line. infra/terraform/monitoring.tf
 * alerts on the lines by their `event`, so those names are a contract with Terraform (held in step
 * by staffSecurityEvents.test.ts). Metadata carries staff ids and reasons, never addresses.
 */
export const STAFF_SIGN_IN_LOG_EVENT = "staff_console.sign_in";
export const STAFF_PRIVILEGED_CHANGE_LOG_EVENT = "staff_console.privileged_change";

type StaffSignInFailureReason =
  | "unknown_email"
  | "wrong_password"
  | "disabled"
  | "provider_error"
  | "invalid_state"
  | "oauth_exchange_failed"
  | "email_unverified"
  | "wrong_workspace"
  | "not_staff"
  | "subject_mismatch";

type StaffSignInMethod = "password" | "google";

type StaffSignIn =
  | { method: StaffSignInMethod; outcome: "success"; staffId: string }
  | { method: StaffSignInMethod; outcome: "failure"; reason: StaffSignInFailureReason; staffId?: string };

interface StaffSecurityAuditPort {
  record(input: {
    accountId?: string | null;
    workspaceId?: string | null;
    eventType: string;
    eventStatus: "success" | "failure";
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
}

interface StaffSecurityLogPort {
  info?(entry: unknown, message?: string): void;
  warn?(entry: unknown, message?: string): void;
}

export class StaffSecurityEvents {
  constructor(
    private readonly audit: StaffSecurityAuditPort,
    private readonly logger: StaffSecurityLogPort = {},
  ) {}

  /** Never throws: a failed audit write must not change the answer to a sign-in. */
  async signIn(attempt: StaffSignIn): Promise<void> {
    const metadata = {
      method: attempt.method,
      ...(attempt.outcome === "failure" ? { reason: attempt.reason } : {}),
      ...(attempt.staffId ? { targetStaffId: attempt.staffId } : {}),
    };
    const entry = { event: STAFF_SIGN_IN_LOG_EVENT, outcome: attempt.outcome, ...metadata };
    if (attempt.outcome === "failure") {
      this.logger.warn?.(entry, "Staff sign-in refused");
    } else {
      this.logger.info?.(entry, "Staff signed in");
    }

    try {
      await this.audit.record({
        accountId: null,
        workspaceId: null,
        eventType: "staff.auth.login",
        eventStatus: attempt.outcome,
        metadata,
      });
    } catch {
      this.logger.warn?.(
        { event: "staff_console.audit_write_failed", eventType: "staff.auth.login" },
        "Staff sign-in audit record was not written",
      );
    }
  }

  /** The alertable line goes first, so an audit outage cannot hide the change it failed to record. */
  async privilegedChange(change: { eventType: string; metadata: Record<string, unknown> }): Promise<void> {
    this.logger.warn?.(
      { event: STAFF_PRIVILEGED_CHANGE_LOG_EVENT, eventType: change.eventType, ...change.metadata },
      "Staff access changed",
    );
    await this.audit.record({
      accountId: null,
      workspaceId: null,
      eventType: change.eventType,
      eventStatus: "success",
      metadata: change.metadata,
    });
  }
}
