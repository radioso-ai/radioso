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
export interface AppStorageAuditEvent {
  workspaceId: string;
  installationId: string | null;
  eventType:
    | "app.data.export.requested"
    | "app.data.export.completed"
    | "app.data.export.cancelled"
    | "app.data.retention.changed"
    | "app.data.deletion.requested"
    | "app.data.deletion.completed";
  eventStatus: "success" | "failure";
  metadata: Record<string, string | number | boolean>;
}

export interface AppStorageAuditPort {
  record(event: AppStorageAuditEvent): Promise<void>;
}
