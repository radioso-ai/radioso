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
  /**
   * The event's own identity, stable across delivery attempts. Delivery is
   * at-least-once — a publish that succeeded and whose acknowledgement did not
   * commit is published again — so a sink that must not record an event twice
   * has something to recognise it by.
   */
  eventId: string;
  /**
   * Null once the workspace itself is gone. The outbox deliberately outlives a
   * workspace deletion — the entries describing the last thing that happened to
   * a workspace are the ones an operator most needs afterwards — so a preserved
   * event has to be publishable without a workspace to attribute it to.
   */
  workspaceId: string | null;
  /**
   * The workspace the event belonged to, when that workspace no longer exists. It
   * is an identifier and nothing else, which is what makes it publishable next to
   * a null `workspaceId` rather than being dropped with it.
   */
  deletedWorkspaceId: string | null;
  installationId: string | null;
}

export interface AppStorageAuditPort {
  record(event: AppStorageAuditEvent): Promise<void>;
}

/**
 * Somewhere to say that recording an event failed, without letting that failure
 * become the answer to what the operator asked.
 *
 * A refused export, a retention deadline outside policy, and a failed deletion
 * each have their own answer, and an unreachable outbox must not replace it. It
 * must not be silent either: an outage that only ever manifests as missing trail
 * entries is one nobody notices. So the classified secondary failure is written
 * out here, and the fields are identifiers and codes — never a record key, a
 * stored value, or a message the database composed around one.
 */
export interface AppStorageAuditLogPort {
  warn(fields: Record<string, string | number | null>, message: string): void;
}
