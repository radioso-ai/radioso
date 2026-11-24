import {
  readWhatsAppNumber,
  whatsAppNumberKey,
  type ChannelPersonKey,
  type ConversationChannelPersonKeys,
} from "../../../../shared/domain/channelPersonKey.js";
import {
  exportTimestamp,
  type DataSubjectDataExporter,
  type DataSubjectExportRecord,
  type ChannelPersonValueHolders,
  type DataSubjectExportScope,
  type DataSubjectIdentityFinder,
  type DataSubjectIdentityMatch,
  type DataSubjectIdentityReach,
} from "../../../../shared/domain/dataSubjectAccess.js";
import { anyOf } from "../../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../../shared/infra/kysely/types.js";
import { exportedWhatsAppMessage } from "./whatsappMessageExport.js";

/**
 * What the WhatsApp channel lets other modules read by a number (#1884), through ports they own: the
 * number a conversation is with, and a data subject found by their number with what it reaches. A
 * number is stored the way Meta reports it as `wa_id`, digits with the country code first, and a
 * search or a key is read the same way (`whatsAppNumberKey`). The number is never logged.
 */

const whatsAppPersonKey = (number: string): ChannelPersonKey => ({ kind: "whatsapp_contact", id: number });

/** The WhatsApp number each conversation is with, recorded when the channel answers on it. */
export class WhatsAppConversationPersonKeys implements ConversationChannelPersonKeys {
  constructor(private readonly db: Db) {}

  async personKeyOf(input: { workspaceId: string; conversationId: string }): Promise<ChannelPersonKey | null> {
    const row = await this.db
      .selectFrom("connector_whatsapp_conversations")
      .select("wa_id")
      .where("workspace_id", "=", input.workspaceId)
      .where("conversation_id", "=", input.conversationId)
      .executeTakeFirst();
    return row ? whatsAppPersonKey(row.wa_id) : null;
  }
}

/** One conversation a number had: recorded against it, or the one its contact row points at. */
interface NumberConversation {
  readonly number: string;
  readonly conversationId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** When a number's messages the transport still logs came, by number. */
interface NumberLogSpan {
  readonly number: string;
  readonly first: Date;
  readonly last: Date;
}

/** What Radioso keeps for some numbers: their conversations, their logged messages, and which have person values. */
interface NumbersHeld {
  readonly conversations: readonly NumberConversation[];
  readonly logged: readonly NumberLogSpan[];
  readonly valued: ReadonlySet<string>;
}

const heldNumbers = (held: NumbersHeld): string[] => [...new Set([
  ...held.conversations.map((conversation) => conversation.number),
  ...held.logged.map((span) => span.number),
  ...held.valued,
])].sort();

/**
 * A data subject by WhatsApp number: every conversation recorded against the number, and the one its
 * contact row points at, its latest; and a number with no conversation left that the transport still
 * logs messages of or a host kept values for. An identity's key is the number's digits; its record ids
 * are its conversations' ids, so an audit event never names the number.
 */
export class WhatsAppNumberIdentityFinder implements DataSubjectIdentityFinder {
  readonly kind = "whatsapp_number" as const;
  readonly channel = "whatsapp";

  constructor(
    private readonly db: Db,
    private readonly values: ChannelPersonValueHolders,
  ) {}

  async find(input: { workspaceId: string; query: string }): Promise<DataSubjectIdentityMatch[]> {
    const number = whatsAppNumberKey(input.query);
    if (!number) return [];
    const held = await this.held(input.workspaceId, [number]);
    if (heldNumbers(held).length === 0) return [];
    const { conversations, logged } = held;
    const firsts = [...conversations.map((conversation) => conversation.createdAt), ...logged.map((span) => span.first)];
    const lasts = [...conversations.map((conversation) => conversation.updatedAt), ...logged.map((span) => span.last)];
    return [{
      key: number,
      label: `+${number}`,
      conversationCount: conversations.length,
      firstSeenAt: firsts.length > 0 ? new Date(Math.min(...firsts.map((time) => time.getTime()))) : null,
      lastSeenAt: lasts.length > 0 ? new Date(Math.max(...lasts.map((time) => time.getTime()))) : null,
      recordIds: conversations.map((conversation) => conversation.conversationId),
    }];
  }

  async reach(input: { workspaceId: string; keys: readonly string[] }): Promise<DataSubjectIdentityReach> {
    const numbers = [...new Set(input.keys.flatMap((key) => whatsAppNumberKey(key) ?? []))];
    const held = numbers.length > 0 ? await this.held(input.workspaceId, numbers) : { conversations: [], logged: [], valued: new Set<string>() };
    const conversationIds = held.conversations.map((conversation) => conversation.conversationId);
    return {
      conversationIds,
      visitorIds: [],
      verifiedCustomerIds: [],
      channelPersonKeys: heldNumbers(held).map(whatsAppPersonKey),
      recordIds: conversationIds,
    };
  }

  /** A query written as a phone number that no `wa_id` can be, such as one without its country code. */
  misreadQuery(query: string): string | null {
    const read = readWhatsAppNumber(query);
    return "refusal" in read && read.writtenAsNumber ? read.refusal : null;
  }

  private async held(workspaceId: string, numbers: readonly string[]): Promise<NumbersHeld> {
    const [conversations, logged, valued] = await Promise.all([
      this.conversationsOf(workspaceId, numbers),
      this.loggedSpans(workspaceId, numbers),
      this.values.keysWithValues({ workspaceId, keys: numbers.map(whatsAppPersonKey) }),
    ]);
    return { conversations, logged, valued: new Set(valued.map((key) => key.id)) };
  }

  private async loggedSpans(workspaceId: string, numbers: readonly string[]): Promise<NumberLogSpan[]> {
    const rows = await this.db
      .selectFrom("connector_whatsapp_message_log")
      .select((eb) => ["wa_id", eb.fn.min("created_at").as("first"), eb.fn.max("created_at").as("last")])
      .where("workspace_id", "=", workspaceId)
      .where((eb) => anyOf(eb.ref("wa_id"), numbers, "text[]"))
      .groupBy("wa_id")
      .execute();
    return rows.map((row) => ({ number: row.wa_id, first: new Date(row.first), last: new Date(row.last) }));
  }

  private async conversationsOf(workspaceId: string, numbers: readonly string[]): Promise<NumberConversation[]> {
    const recorded = this.db
      .selectFrom("connector_whatsapp_conversations as n")
      .select(["n.wa_id as number", "n.conversation_id"])
      .where("n.workspace_id", "=", workspaceId)
      .where((eb) => anyOf(eb.ref("n.wa_id"), numbers, "text[]"));
    // The contact row's conversation is recorded too; a row written by a release that recorded none is read from the contact.
    const latest = this.db
      .selectFrom("connector_whatsapp_contacts as k")
      .select(["k.wa_id as number", "k.conversation_id"])
      .where("k.workspace_id", "=", workspaceId)
      .where((eb) => anyOf(eb.ref("k.wa_id"), numbers, "text[]"));
    const rows = await this.db
      .selectFrom(recorded.union(latest).as("number_conversations"))
      .innerJoin("conversations as c", "c.id", "number_conversations.conversation_id")
      .select(["number_conversations.number", "c.id", "c.created_at", "c.updated_at"])
      .where("c.workspace_id", "=", workspaceId)
      .orderBy("c.created_at")
      .orderBy("c.id")
      .execute();
    return rows.map((row) => ({
      number: row.number,
      conversationId: row.id,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));
  }
}

const whatsAppNumbersOf = (scope: DataSubjectExportScope): string[] =>
  scope.channelPersonKeys.flatMap((key) => (key.kind === "whatsapp_contact" ? [key.id] : []));

/** The export's `whatsapp_contacts` section: the contact row of each of the subject's numbers. */
export class WhatsAppContactExporter implements DataSubjectDataExporter {
  readonly section = "whatsapp_contacts";

  constructor(private readonly db: Db) {}

  async export(scope: DataSubjectExportScope): Promise<DataSubjectExportRecord[]> {
    const numbers = whatsAppNumbersOf(scope);
    if (numbers.length === 0) return [];
    const rows = await this.db
      .selectFrom("connector_whatsapp_contacts")
      .select(["wa_id", "profile_name", "conversation_id", "first_seen_at", "last_message_at"])
      .where("workspace_id", "=", scope.workspaceId)
      .where((eb) => anyOf(eb.ref("wa_id"), numbers, "text[]"))
      .orderBy("wa_id")
      .execute();
    return rows.map((row) => ({
      number: `+${row.wa_id}`,
      profileName: row.profile_name,
      latestConversationId: row.conversation_id,
      firstSeenAt: exportTimestamp(new Date(row.first_seen_at)),
      lastMessageAt: exportTimestamp(new Date(row.last_message_at)),
    }));
  }
}

/**
 * The export's `whatsapp_messages` section: each message the subject's numbers sent or were sent that
 * the WhatsApp transport still logs, as `exportedWhatsAppMessage` projects it. The log keeps a
 * message for 90 days, and less once the number's latest conversation is erased.
 */
export class WhatsAppMessageLogExporter implements DataSubjectDataExporter {
  readonly section = "whatsapp_messages";

  constructor(private readonly db: Db) {}

  async export(scope: DataSubjectExportScope): Promise<DataSubjectExportRecord[]> {
    const numbers = whatsAppNumbersOf(scope);
    if (numbers.length === 0) return [];
    const rows = await this.db
      .selectFrom("connector_whatsapp_message_log")
      .select(["wamid", "wa_id", "direction", "message_type", "status", "payload", "created_at"])
      .where("workspace_id", "=", scope.workspaceId)
      .where((eb) => anyOf(eb.ref("wa_id"), numbers, "text[]"))
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return rows.map((row) => exportedWhatsAppMessage({
      wamid: row.wamid,
      waId: row.wa_id,
      direction: row.direction,
      messageType: row.message_type,
      status: row.status,
      payload: row.payload,
      createdAt: new Date(row.created_at),
    }));
  }
}
