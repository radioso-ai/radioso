/**
 * The audit trail managed App data leaves. Every event carries identities and
 * counts; none carries a record key or a stored value, because the point of the
 * trail is to show an operator that a disposition happened, not what was in it.
 *
 * An event that did not happen is recorded too. An export whose consumer stopped
 * early, a retention deadline outside policy, and a deletion that failed all
 * leave a `failure` event, because a trail that only records successes cannot be
 * used to answer what became of the data.
 */
export type AppStorageAuditEventType =
  | "app.data.export.requested"
  | "app.data.export.completed"
  | "app.data.export.cancelled"
  | "app.data.retention.changed"
  | "app.data.deletion.requested"
  | "app.data.deletion.completed";

/**
 * What an event says, without the identities it says it about. An irreversible
 * disposition commits its intent in the same transaction as the change itself, so
 * the intent is written where the change is and carries only what the change
 * knows.
 */
export interface AppStorageAuditIntent {
  eventType: AppStorageAuditEventType;
  eventStatus: "success" | "failure";
  metadata: Record<string, string | number | boolean>;
}

export interface AppStorageAuditEvent extends AppStorageAuditIntent {
  workspaceId: string;
  installationId: string | null;
}

export interface AppStorageAuditPort {
  record(event: AppStorageAuditEvent): Promise<void>;
}
