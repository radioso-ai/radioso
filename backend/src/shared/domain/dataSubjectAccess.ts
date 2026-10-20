/**
 * Access to one data subject's data: the person a workspace's conversations are with, as each
 * channel knows them.
 *
 * Identity is split by channel: a web visitor record, an email sender's address, a Slack user.
 * Radioso never merges them on its own. A module that keeps identities implements a finder, which
 * matches an operator's search against them and says what an identity the operator confirmed
 * reaches. A module that keeps data about the subject implements an exporter for its section of the
 * export. Application composition binds both to one read transaction, so an export reads one
 * consistent snapshot.
 */

export const DATA_SUBJECT_IDENTITY_KINDS = ["web_visitor", "email_address", "slack_user"] as const;

export type DataSubjectIdentityKind = (typeof DATA_SUBJECT_IDENTITY_KINDS)[number];

/** One identity, named by the finder that keeps it. */
export interface DataSubjectIdentity {
  readonly kind: DataSubjectIdentityKind;
  /** The finder's own key: a visitor id, a lowercased address, a Slack team and user. */
  readonly key: string;
}

/** An identity a search matched, for an operator to confirm or leave out. */
export interface DataSubjectIdentityMatch {
  readonly key: string;
  /** How the channel knows the person: a verified customer id, an address, a Slack user id. */
  readonly label: string;
  readonly conversationCount: number;
  readonly firstSeenAt: Date | null;
  readonly lastSeenAt: Date | null;
  /**
   * Radioso's own ids for the records the identity is made of: a visitor record, Slack link rows,
   * email thread links (keyed by their conversation). Audit events name an identity by these, never
   * by its key, which can be the person's own address.
   */
  readonly recordIds: readonly string[];
}

/** What confirmed identities reach in a workspace. */
export interface DataSubjectReach {
  readonly conversationIds: readonly string[];
  /** The web visitor records among the identities; a subject's erasure erases each as a visitor. */
  readonly visitorIds: readonly string[];
  /** Host-verified customer ids those visitors carry, which customer-scoped data is stored by. */
  readonly verifiedCustomerIds: readonly string[];
}

/** What one finder's keys reach, with the ids of the identity records they resolved to. */
export interface DataSubjectIdentityReach extends DataSubjectReach {
  readonly recordIds: readonly string[];
}

/** One module's identities of one kind. */
export interface DataSubjectIdentityFinder {
  readonly kind: DataSubjectIdentityKind;
  /** The conversation channel its identities are on. */
  readonly channel: string;
  /** The identities whose channel identifier is exactly `query`, compared the way the channel compares them. */
  find(input: { workspaceId: string; query: string }): Promise<readonly DataSubjectIdentityMatch[]>;
  /** What the keys reach. A key the finder does not keep reaches nothing. */
  reach(input: { workspaceId: string; keys: readonly string[] }): Promise<DataSubjectIdentityReach>;
}

/** A JSON value in an export. */
export type DataSubjectExportValue =
  | string
  | number
  | boolean
  | null
  | readonly DataSubjectExportValue[]
  | { readonly [field: string]: DataSubjectExportValue };

/** One row of an export section. */
export type DataSubjectExportRecord = { readonly [field: string]: DataSubjectExportValue };

/** What an export covers: everything the confirmed identities reach in one workspace. */
export interface DataSubjectExportScope extends DataSubjectReach {
  readonly workspaceId: string;
}

/** One module's section of a data subject's export. */
export interface DataSubjectDataExporter {
  /** The section's name in the export, such as `routine_values`. One exporter writes each section. */
  readonly section: string;
  export(scope: DataSubjectExportScope): Promise<readonly DataSubjectExportRecord[]>;
}

/** A timestamp as an export carries it. */
export const exportTimestamp = (value: Date | null): string | null => (value ? value.toISOString() : null);

/** A `jsonb` column's value, which Postgres hands back as JSON. */
export const exportJson = (value: unknown): DataSubjectExportValue => (value ?? null) as DataSubjectExportValue;
