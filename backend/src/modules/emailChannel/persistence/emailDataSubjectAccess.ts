import {
  exportJson,
  exportTimestamp,
  type DataSubjectDataExporter,
  type DataSubjectExportRecord,
  type DataSubjectExportScope,
  type DataSubjectIdentityFinder,
  type DataSubjectIdentityMatch,
  type DataSubjectIdentityReach,
} from "../../../shared/domain/dataSubjectAccess.js";
import { anyOf } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";

/** Thread links store a participant's address lowercased; a search compares it the same way. */
const normalizeAddress = (address: string): string => address.trim().toLowerCase();

/**
 * Email senders as data subject identities: the address a thread's participant writes from, across
 * every mailbox of the workspace, keyed by the address itself. Its records are its thread links,
 * which are keyed by their conversation.
 */
export class EmailSenderIdentityFinder implements DataSubjectIdentityFinder {
  readonly kind = "email_address" as const;
  readonly channel = "email";

  constructor(private readonly db: Db) {}

  async find(input: { workspaceId: string; query: string }): Promise<DataSubjectIdentityMatch[]> {
    const address = normalizeAddress(input.query);
    const row = await this.threads(input.workspaceId, [address])
      .select((eb) => [
        eb.fn.countAll<string>().as("conversation_count"),
        eb.fn.min("l.created_at").as("first_seen_at"),
        eb.fn.max(eb.fn.coalesce("l.latest_inbound_at", "l.created_at")).as("last_seen_at"),
        eb.fn.agg<string[]>("array_agg", ["l.conversation_id"]).as("conversation_ids"),
      ])
      .executeTakeFirst();
    const conversationCount = Number(row?.conversation_count ?? 0);
    if (!row || conversationCount === 0) return [];
    return [{
      key: address,
      label: address,
      conversationCount,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      recordIds: row.conversation_ids,
    }];
  }

  async reach(input: { workspaceId: string; keys: readonly string[] }): Promise<DataSubjectIdentityReach> {
    const addresses = [...new Set(input.keys.map(normalizeAddress))];
    const rows = addresses.length === 0 ? [] : await this.threads(input.workspaceId, addresses).select("l.conversation_id").execute();
    const conversationIds = rows.map((row) => row.conversation_id);
    return { conversationIds, visitorIds: [], verifiedCustomerIds: [], recordIds: conversationIds };
  }

  /** The workspace's threads with these participants, through the mailbox and participant index. */
  private threads(workspaceId: string, addresses: readonly string[]) {
    return this.db
      .selectFrom("email_thread_links as l")
      .where("l.workspace_id", "=", workspaceId)
      .where("l.mailbox_id", "in", (eb) => eb.selectFrom("email_mailboxes").select("id").where("workspace_id", "=", workspaceId))
      .where((eb) => anyOf(eb.ref("l.participant_address"), addresses, "text[]"));
  }
}

/**
 * The export's `email_messages` section: each mail of the subject's email conversations as the
 * channel recorded it, with the sender, subject, Cc and attachment names an inbound one came with.
 * Its body is the conversation's message; the raw MIME stays out.
 */
export class EmailMessageExporter implements DataSubjectDataExporter {
  readonly section = "email_messages";

  constructor(private readonly db: Db) {}

  async export(scope: DataSubjectExportScope): Promise<DataSubjectExportRecord[]> {
    if (scope.conversationIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("email_thread_messages as m")
      .leftJoin("email_inbound_deliveries as d", "d.id", "m.inbound_delivery_id")
      .select([
        "m.conversation_id",
        "m.message_id",
        "m.direction",
        "m.subject",
        "m.cc_addresses",
        "m.attachments",
        "m.created_at",
        "d.sender_address",
        "d.sender_display_name",
      ])
      .where("m.workspace_id", "=", scope.workspaceId)
      .where((eb) => anyOf(eb.ref("m.conversation_id"), scope.conversationIds, "uuid[]"))
      .orderBy("m.created_at")
      .orderBy("m.id")
      .execute();
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      messageId: row.message_id,
      direction: row.direction,
      subject: row.subject,
      senderAddress: row.sender_address,
      senderDisplayName: row.sender_display_name,
      ccAddresses: row.cc_addresses,
      attachments: exportJson(row.attachments),
      createdAt: exportTimestamp(row.created_at),
    }));
  }
}
