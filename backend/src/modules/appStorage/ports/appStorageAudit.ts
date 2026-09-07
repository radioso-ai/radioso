/**
 * The audit trail managed App data leaves. Every event carries identities and
 * counts; none carries a record key or a stored value, because the point of the
 * trail is to show an operator that a disposition happened, not what was in it.
 */
export interface AppStorageAuditEvent {
  workspaceId: string;
  installationId: string | null;
  eventType:
    | "app.data.export.requested"
    | "app.data.export.completed"
    | "app.data.retention.changed"
    | "app.data.deletion.requested"
    | "app.data.deletion.completed";
  eventStatus: "success" | "failure";
  metadata: Record<string, string | number | boolean>;
}

export interface AppStorageAuditPort {
  record(event: AppStorageAuditEvent): Promise<void>;
}
