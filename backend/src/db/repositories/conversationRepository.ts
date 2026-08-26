import { randomUUID } from "node:crypto";
import type { ConversationChannelContext } from "@radioso/conversation-contract";
import type { MessageRecord } from "./messageRepository.js";

import { decodeCursorWithKeys, encodeCursor } from "../../shared/domain/cursorPagination.js";
import {
  OPERATOR_TEST_SOURCE_CHANNELS,
  WORKBENCH_TEST_SOURCE_CHANNELS,
  type ConversationSourceScope,
} from "../../shared/domain/conversationSource.js";
import { normalizeNullableText } from "../../shared/domain/nullableText.js";
import type { ConversationOwnershipScope } from "../../modules/handoff/ownershipState.js";
import {
  currentTimestamp,
  toJsonb,
  transactionAdvisoryLock,
} from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export interface ConversationRecord {
  id: string;
  workspaceId: string;
  agentId: string | null;
  agentName: string | null;
  agentInternalName: string | null;
  sourceChannel: string | null;
  sourceOrigin: string | null;
  channelContext: ConversationChannelContext | null;
  anonymousSessionId: string | null;
  verifiedCustomerId: string | null;
  entryPageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GetOrCreateConversationResult {
  record: ConversationRecord;
  created: boolean;
}

export interface ConversationRepositoryPort {
  // MCP converse requires this capability, while replay/eval repository doubles do not.
  // AgentConverseService fails closed when an application adapter omits it.
  getOrCreateByAnonymousSession?(input: {
    workspaceId: string;
    agentId: string;
    sourceChannel: string;
    anonymousSessionId: string;
    sourceOrigin?: string | null;
  }): Promise<GetOrCreateConversationResult>;
  create(
    workspaceId: string,
    agentId?: string | null,
    sourceChannel?: string | null,
    anonymousSessionId?: string | null,
    sourceOrigin?: string | null,
    channelContext?: ConversationChannelContext | null,
    verifiedCustomerId?: string | null,
    options?: { entryPageUrl?: string | null },
  ): Promise<ConversationRecord>;
  createWithInitialAssistantMessage(input: {
    workspaceId: string;
    agentId?: string | null;
    sourceChannel?: string | null;
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
    channelContext?: ConversationChannelContext | null;
    verifiedCustomerId?: string | null;
    entryPageUrl?: string | null;
    content: string;
  }): Promise<{ conversation: ConversationRecord; assistantMessage: MessageRecord }>;
  listPageByWorkspaceId(
    workspaceId: string,
    input: {
      limit: number;
      offset?: number;
      cursor?: string;
      sourceScope?: ConversationSourceScope;
      ownership?: ConversationOwnershipScope;
    },
  ): Promise<{ conversations: ConversationRecord[]; total: number; nextCursor: string | null; hasMore: boolean }>;
  countByWorkspaceId(workspaceId: string): Promise<number>;
  listPageByAnonymousSession(
    workspaceId: string,
    anonymousSessionId: string,
    input: { limit: number; offset?: number; cursor?: string; agentId?: string | null },
  ): Promise<{ conversations: ConversationRecord[]; total: number; nextCursor: string | null; hasMore: boolean }>;
  findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<ConversationRecord | null>;
  findByIdAndAnonymousSession(
    conversationId: string,
    workspaceId: string,
    anonymousSessionId: string,
    agentId?: string | null,
  ): Promise<ConversationRecord | null>;
  setVerifiedCustomerId(conversationId: string, workspaceId: string, customerId: string): Promise<void>;
  touch(conversationId: string, workspaceId: string): Promise<void>;
}

interface ConversationRow {
  // SQL rows keep database column names; repository records are the camelCase boundary type.
  id: string;
  workspace_id: string;
  agent_id: string | null;
  agent_name?: string | null;
  agent_internal_name?: string | null;
  source_channel: string | null;
  source_origin: string | null;
  channel_context?: ConversationChannelContext | null;
  anonymous_session_id: string | null;
  verified_customer_id: string | null;
  entry_page_url: string | null;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  workspace_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: Date;
}

const conversationColumns = [
  "id",
  "workspace_id",
  "agent_id",
  "source_channel",
  "source_origin",
  "channel_context",
  "anonymous_session_id",
  "verified_customer_id",
  "entry_page_url",
  "created_at",
  "updated_at",
] as const;

const conversationSelectColumns = [
  "c.id as id",
  "c.workspace_id as workspace_id",
  "c.agent_id as agent_id",
  "a.name as agent_name",
  "a.internal_name as agent_internal_name",
  "c.source_channel as source_channel",
  "c.source_origin as source_origin",
  "c.channel_context as channel_context",
  "c.anonymous_session_id as anonymous_session_id",
  "c.verified_customer_id as verified_customer_id",
  "c.entry_page_url as entry_page_url",
  "c.created_at as created_at",
  "c.updated_at as updated_at",
] as const;

const initialAssistantMessageColumns = [
  "id",
  "conversation_id",
  "workspace_id",
  "role",
  "content",
  "created_at",
] as const;

// Kysely `$if` predicates for the source-scope filter. The count query is unaliased
// (`source_channel`); the list query aliases the table as `c` (`c.source_channel`).
// `end_user` is NULL-safe (real conversations often have a NULL source_channel).
const operatorTestChannels = [...OPERATOR_TEST_SOURCE_CHANNELS];
const workbenchTestChannels = [...WORKBENCH_TEST_SOURCE_CHANNELS];

const mapConversation = (row: ConversationRow): ConversationRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  agentId: row.agent_id ?? null,
  agentName: row.agent_name ?? null,
  agentInternalName: normalizeNullableText(row.agent_internal_name),
  sourceChannel: row.source_channel,
  sourceOrigin: row.source_origin ?? null,
  channelContext: (row.channel_context as ConversationChannelContext | null) ?? null,
  anonymousSessionId: row.anonymous_session_id ?? null,
  verifiedCustomerId: row.verified_customer_id ?? null,
  entryPageUrl: row.entry_page_url ?? null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class ConversationRepository implements ConversationRepositoryPort {
  constructor(private readonly db: Db) {}

  async getOrCreateByAnonymousSession(input: {
    workspaceId: string;
    agentId: string;
    sourceChannel: string;
    anonymousSessionId: string;
    sourceOrigin?: string | null;
  }): Promise<GetOrCreateConversationResult> {
    return this.db.transaction().execute(async (trx) => {
      const lockKey = [
        "anonymous_conversation",
        input.workspaceId,
        input.agentId,
        input.sourceChannel,
        input.anonymousSessionId,
      ].join(":");
      await transactionAdvisoryLock(lockKey).execute(trx);

      const existing = await trx
        .selectFrom("conversations")
        .select(conversationColumns)
        .where("workspace_id", "=", input.workspaceId)
        .where("agent_id", "=", input.agentId)
        .where("source_channel", "=", input.sourceChannel)
        .where("anonymous_session_id", "=", input.anonymousSessionId)
        .orderBy("updated_at", "desc")
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .executeTakeFirst();
      if (existing) {
        return { record: mapConversation(existing as ConversationRow), created: false };
      }

      const created = await trx
        .insertInto("conversations")
        .values({
          id: randomUUID(),
          workspace_id: input.workspaceId,
          agent_id: input.agentId,
          source_channel: input.sourceChannel,
          source_origin: input.sourceOrigin ?? null,
          anonymous_session_id: input.anonymousSessionId,
        })
        .returning(conversationColumns)
        .executeTakeFirstOrThrow();
      return { record: mapConversation(created as ConversationRow), created: true };
    });
  }

  async create(
    workspaceId: string,
    agentId: string | null = null,
    sourceChannel: string | null = null,
    anonymousSessionId: string | null = null,
    sourceOrigin: string | null = null,
    channelContext: ConversationChannelContext | null = null,
    verifiedCustomerId: string | null = null,
    options?: { entryPageUrl?: string | null },
  ): Promise<ConversationRecord> {
    const row = await this.db
      .insertInto("conversations")
      .values({
        id: randomUUID(),
        workspace_id: workspaceId,
        agent_id: agentId,
        source_channel: sourceChannel,
        source_origin: sourceOrigin,
        channel_context: channelContext ? toJsonb(channelContext) : null,
        anonymous_session_id: anonymousSessionId,
        verified_customer_id: verifiedCustomerId,
        entry_page_url: options?.entryPageUrl ?? null,
      })
      .returning(conversationColumns)
      .executeTakeFirstOrThrow();

    return mapConversation(row as ConversationRow);
  }

  async createWithInitialAssistantMessage(input: {
    workspaceId: string;
    agentId?: string | null;
    sourceChannel?: string | null;
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
    channelContext?: ConversationChannelContext | null;
    verifiedCustomerId?: string | null;
    entryPageUrl?: string | null;
    content: string;
  }): Promise<{ conversation: ConversationRecord; assistantMessage: MessageRecord }> {
    return this.db.transaction().execute(async (trx) => {
      const conversationId = randomUUID();
      const messageId = randomUUID();
      const conversationRow = await trx
        .insertInto("conversations")
        .values({
          id: conversationId,
          workspace_id: input.workspaceId,
          agent_id: input.agentId ?? null,
          source_channel: input.sourceChannel ?? null,
          source_origin: input.sourceOrigin ?? null,
          channel_context: input.channelContext ? toJsonb(input.channelContext) : null,
          anonymous_session_id: input.anonymousSessionId ?? null,
          verified_customer_id: input.verifiedCustomerId ?? null,
          entry_page_url: input.entryPageUrl ?? null,
        })
        .returning(conversationColumns)
        .executeTakeFirstOrThrow();
      const messageRow = await trx
        .insertInto("messages")
        .values({
          id: messageId,
          conversation_id: conversationId,
          workspace_id: input.workspaceId,
          role: "assistant",
          content: input.content,
        })
        .returning(initialAssistantMessageColumns)
        .executeTakeFirstOrThrow() as MessageRow;

      return {
        conversation: mapConversation(conversationRow as ConversationRow),
        assistantMessage: {
          id: messageRow.id,
          conversationId: messageRow.conversation_id,
          workspaceId: messageRow.workspace_id,
          role: messageRow.role,
          content: messageRow.content,
          createdAt: new Date(messageRow.created_at),
        },
      };
    });
  }

  async listPageByWorkspaceId(
    workspaceId: string,
    input: {
      limit: number;
      offset?: number;
      cursor?: string;
      sourceScope?: ConversationSourceScope;
      ownership?: ConversationOwnershipScope;
    },
  ): Promise<{ conversations: ConversationRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["updatedAt", "createdAt", "id"]) : null;
    const scope: ConversationSourceScope = input.sourceScope ?? "end_user";
    const total = cursor?.totalSnapshot !== undefined
      ? Number(cursor.totalSnapshot)
      : Number((await this.db
          .selectFrom("conversations as c")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("c.workspace_id", "=", workspaceId)
          .$if(scope === "end_user", (qb) =>
            qb.where((eb) =>
              eb.or([
                eb("c.source_channel", "is", null),
                eb("c.source_channel", "not in", operatorTestChannels),
              ]),
            ),
          )
          .$if(scope === "operator_test", (qb) => qb.where("c.source_channel", "in", workbenchTestChannels))
          .$if(input.ownership === "human_owned", (qb) =>
            qb
              .innerJoin("conversation_ownership as co", (join) =>
                join.onRef("co.conversation_id", "=", "c.id").onRef("co.workspace_id", "=", "c.workspace_id"),
              )
              .where("co.state", "=", "human_owned"),
          )
          .executeTakeFirst())?.count ?? "0");
    const query = this.db
      .selectFrom("conversations as c")
      .leftJoin("agents as a", (join) =>
        join.onRef("a.id", "=", "c.agent_id").onRef("a.workspace_id", "=", "c.workspace_id"),
      )
      .select(conversationSelectColumns)
      .where("c.workspace_id", "=", workspaceId)
      .$if(input.ownership === "human_owned", (qb) =>
        qb
          .innerJoin("conversation_ownership as co", (join) =>
            join.onRef("co.conversation_id", "=", "c.id").onRef("co.workspace_id", "=", "c.workspace_id"),
          )
          .where("co.state", "=", "human_owned"),
      )
      .$if(scope === "end_user", (qb) =>
        qb.where((eb) =>
          eb.or([
            eb("c.source_channel", "is", null),
            eb("c.source_channel", "not in", operatorTestChannels),
          ]),
        ),
      )
      .$if(scope === "operator_test", (qb) => qb.where("c.source_channel", "in", workbenchTestChannels))
      .$if(Boolean(cursor), (qb) =>
        qb.where((eb) =>
          eb.or([
            eb("c.updated_at", "<", new Date(cursor!.keys.updatedAt)),
            eb.and([
              eb("c.updated_at", "=", new Date(cursor!.keys.updatedAt)),
              eb.or([
                eb("c.created_at", "<", new Date(cursor!.keys.createdAt)),
                eb.and([
                  eb("c.created_at", "=", new Date(cursor!.keys.createdAt)),
                  eb("c.id", "<", cursor!.keys.id),
                ]),
              ]),
            ]),
          ]),
        ),
      )
      .orderBy("c.updated_at", "desc")
      .orderBy("c.created_at", "desc")
      .orderBy("c.id", "desc")
      .limit(input.limit + 1)
      .$if(!cursor, (qb) => qb.offset(input.offset ?? 0));

    const rows = await query.execute() as ConversationRow[];

    const conversations = rows.slice(0, input.limit).map(mapConversation);
    const hasMore = rows.length > input.limit;
    const lastConversation = conversations.at(-1);

    return {
      conversations,
      total,
      nextCursor: hasMore && lastConversation
        ? encodeCursor({
            updatedAt: lastConversation.updatedAt.toISOString(),
            createdAt: lastConversation.createdAt.toISOString(),
            id: lastConversation.id,
          }, total)
        : null,
      hasMore,
    };
  }

  async countByWorkspaceId(workspaceId: string): Promise<number> {
    const row = await this.db
      .selectFrom("conversations")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();

    return Number(row?.count ?? "0");
  }

  async findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<ConversationRecord | null> {
    const row = await this.db
      .selectFrom("conversations as c")
      .leftJoin("agents as a", (join) =>
        join.onRef("a.id", "=", "c.agent_id").onRef("a.workspace_id", "=", "c.workspace_id"),
      )
      .select(conversationSelectColumns)
      .where("c.id", "=", conversationId)
      .where("c.workspace_id", "=", workspaceId)
      .executeTakeFirst() as ConversationRow | undefined;

    return row ? mapConversation(row) : null;
  }

  async listPageByAnonymousSession(
    workspaceId: string,
    anonymousSessionId: string,
    input: { limit: number; offset?: number; cursor?: string; agentId?: string | null },
  ): Promise<{ conversations: ConversationRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["updatedAt", "createdAt", "id"]) : null;
    const total = cursor?.totalSnapshot !== undefined
      ? Number(cursor.totalSnapshot)
      : Number((await this.db
          .selectFrom("conversations as c")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("c.workspace_id", "=", workspaceId)
          .where("c.anonymous_session_id", "=", anonymousSessionId)
          .$if(Boolean(input.agentId), (qb) => qb.where("c.agent_id", "=", input.agentId!))
          .executeTakeFirst())?.count ?? "0");
    const query = this.db
      .selectFrom("conversations as c")
      .leftJoin("agents as a", (join) =>
        join.onRef("a.id", "=", "c.agent_id").onRef("a.workspace_id", "=", "c.workspace_id"),
      )
      .select(conversationSelectColumns)
      .where("c.workspace_id", "=", workspaceId)
      .where("c.anonymous_session_id", "=", anonymousSessionId)
      .$if(Boolean(input.agentId), (qb) => qb.where("c.agent_id", "=", input.agentId!))
      .$if(Boolean(cursor), (qb) =>
        qb.where((eb) =>
          eb.or([
            eb("c.updated_at", "<", new Date(cursor!.keys.updatedAt)),
            eb.and([
              eb("c.updated_at", "=", new Date(cursor!.keys.updatedAt)),
              eb.or([
                eb("c.created_at", "<", new Date(cursor!.keys.createdAt)),
                eb.and([
                  eb("c.created_at", "=", new Date(cursor!.keys.createdAt)),
                  eb("c.id", "<", cursor!.keys.id),
                ]),
              ]),
            ]),
          ]),
        ),
      )
      .orderBy("c.updated_at", "desc")
      .orderBy("c.created_at", "desc")
      .orderBy("c.id", "desc")
      .limit(input.limit + 1)
      .$if(!cursor, (qb) => qb.offset(input.offset ?? 0));

    const rows = await query.execute() as ConversationRow[];

    const conversations = rows.slice(0, input.limit).map(mapConversation);
    const hasMore = rows.length > input.limit;
    const lastConversation = conversations.at(-1);

    return {
      conversations,
      total,
      nextCursor: hasMore && lastConversation
        ? encodeCursor({
            updatedAt: lastConversation.updatedAt.toISOString(),
            createdAt: lastConversation.createdAt.toISOString(),
            id: lastConversation.id,
          }, total)
        : null,
      hasMore,
    };
  }

  async findByIdAndAnonymousSession(
    conversationId: string,
    workspaceId: string,
    anonymousSessionId: string,
    agentId?: string | null,
  ): Promise<ConversationRecord | null> {
    const row = await this.db
      .selectFrom("conversations as c")
      .leftJoin("agents as a", (join) =>
        join.onRef("a.id", "=", "c.agent_id").onRef("a.workspace_id", "=", "c.workspace_id"),
      )
      .select(conversationSelectColumns)
      .where("c.id", "=", conversationId)
      .where("c.workspace_id", "=", workspaceId)
      .where("c.anonymous_session_id", "=", anonymousSessionId)
      .$if(Boolean(agentId), (qb) => qb.where("c.agent_id", "=", agentId!))
      .executeTakeFirst() as ConversationRow | undefined;

    return row ? mapConversation(row) : null;
  }

  async touch(conversationId: string, workspaceId: string): Promise<void> {
    await this.db
      .updateTable("conversations")
      .set({ updated_at: currentTimestamp() })
      .where("id", "=", conversationId)
      .where("workspace_id", "=", workspaceId)
      .execute();
  }

  async setVerifiedCustomerId(conversationId: string, workspaceId: string, customerId: string): Promise<void> {
    await this.db
      .updateTable("conversations")
      .set({ verified_customer_id: customerId, updated_at: currentTimestamp() })
      .where("id", "=", conversationId)
      .where("workspace_id", "=", workspaceId)
      .where("verified_customer_id", "is", null)
      .execute();
  }
}
