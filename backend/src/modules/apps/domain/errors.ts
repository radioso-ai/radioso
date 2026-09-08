/**
 * Reasons the Apps control plane refuses or abandons work. Transport maps these to
 * status codes; the domain never knows about HTTP.
 */
export const appsErrorReasons = [
  "invalid_configuration",
  "connection_invalid",
  "connection_slot_unknown",
  "connection_unbound",
  "connections_unbound",
  "connection_encryption_unavailable",
  "plan_stale",
  "invalid_transition",
  "installation_conflict",
  "installation_removing",
  "operation_in_progress",
  "idempotency_key_reused",
  "runtime_unavailable",
  "staging_unavailable",
  "safe_test_failed",
  "data_disposition_unavailable",
  "initiating_principal_unauthorized",
  "authorization_unavailable",
  "release_not_admitted",
  "release_not_eligible",
] as const;

export type AppsErrorReason = (typeof appsErrorReasons)[number];

/**
 * `details` is bounded, machine-readable context — a cause discriminator, an identifier,
 * a field key. It must never carry a secret, a manifest body, or a payload.
 */
export class AppsError extends Error {
  readonly reason: AppsErrorReason;
  readonly details?: Readonly<Record<string, string | number>>;

  constructor(reason: AppsErrorReason, message: string, details?: Readonly<Record<string, string | number>>) {
    super(message);
    this.name = "AppsError";
    this.reason = reason;
    this.details = details;
  }
}
