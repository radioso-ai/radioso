import { sql, type RawBuilder } from "kysely";

import type { AuditEventRecord } from "./auditEventRepository.js";
import type { ConversationRecord } from "./conversationRepository.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { ConversationChannelContext } from "@radioso/conversation-contract";
import {
  OPERATOR_TEST_SOURCE_CHANNELS,
  WORKBENCH_TEST_SOURCE_CHANNELS,
  type ConversationSourceScope,
} from "../../shared/domain/conversationSource.js";
import {
  CONVERSATION_OUTCOME_IN_PROGRESS_WINDOW_MINUTES,
  type ConversationOutcomeFilter,
} from "../../shared/domain/conversationOutcome.js";
import { normalizeNullableText } from "../../shared/domain/nullableText.js";

// Structural LIKE/ILIKE escaping — not product-vocabulary matching. Postgres treats a bare
// %, _, or \ in an ILIKE pattern as a wildcard/escape character; the operator's search text
// must match those characters literally.
const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, (match) => `\\${match}`);

const toContainsPattern = (value: string): string => `%${escapeLikePattern(value)}%`;

/**
 * `q` matches the same text the row displays (see `resolveConversationDisplayTitle` on the
 * frontend): the generated title, OR the conversation's first non-blank user-role message —
 * the same message `messageRepository.summarizeByConversationIds`'s DISTINCT ON preview query
 * surfaces for this conversation. A later message (an assistant reply, or a second user
 * message) never counts; only the single earliest non-blank user message does.
 */
const buildTextSearchFilter = (
  q: string | undefined,
  idColumn: RawBuilder<unknown>,
  workspaceColumn: RawBuilder<unknown>,
  titleColumn: RawBuilder<unknown>,
): RawBuilder<unknown> => {
  if (!q) {
    return sql``;
  }
  const pattern = toContainsPattern(q);
  return sql`AND (
    ${titleColumn} ILIKE ${pattern}
    OR (
      SELECT m.content
      FROM messages m
      WHERE m.conversation_id = ${idColumn}
        AND m.workspace_id = ${workspaceColumn}
        AND m.role = 'user'
        AND btrim(m.content) <> ''
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT 1
    ) ILIKE ${pattern}
  )`;
};

const buildAgentFilter = (agentId: string | undefined, column: RawBuilder<unknown>): RawBuilder<unknown> =>
  agentId ? sql`AND ${column} = ${agentId}` : sql``;

const buildSourceOriginFilter = (sourceOrigin: string | undefined, column: RawBuilder<unknown>): RawBuilder<unknown> =>
  sourceOrigin ? sql`AND ${column} = ${sourceOrigin}` : sql``;

/**
 * Mirrors `deriveConversationOutcome` (`frontend/lib/conversation-outcome.ts`) in SQL: an
 * `conversation_ownership` row in state `human_owned` always wins over recency — that single
 * state covers both an unclaimed handoff request and one a teammate has taken over, exactly
 * like the frontend's one `ownership` signal doesn't distinguish them either. Otherwise
 * recency against the shared in-progress window decides.
 */
const buildOutcomeFilter = (
  outcome: ConversationOutcomeFilter | undefined,
  idColumn: RawBuilder<unknown>,
  workspaceColumn: RawBuilder<unknown>,
  updatedAtColumn: RawBuilder<unknown>,
): RawBuilder<unknown> => {
  if (!outcome) {
    return sql``;
  }
  const handedOff = sql`EXISTS (
    SELECT 1 FROM conversation_ownership co
    WHERE co.conversation_id = ${idColumn}
      AND co.workspace_id = ${workspaceColumn}
      AND co.state = 'human_owned'
  )`;
  if (outcome === "handed_off") {
    return sql`AND ${handedOff}`;
  }
  const withinWindow = sql`${updatedAtColumn} >= now() - (${CONVERSATION_OUTCOME_IN_PROGRESS_WINDOW_MINUTES}::int * interval '1 minute')`;
  if (outcome === "in_progress") {
    return sql`AND NOT (${handedOff}) AND ${withinWindow}`;
  }
  return sql`AND NOT (${handedOff}) AND NOT (${withinWindow})`;
};

// A parameterized `AND` fragment that filters conversation rows by source scope. `column` is the
// (correctly aliased) `source_channel` reference to use — the CTE reads `c.source_channel`, the
// count subquery reads the unaliased `conversations.source_channel`. `end_user` must be NULL-safe:
// `NOT IN` yields NULL (not TRUE) for NULL rows, so real (NULL-source) conversations need the
// explicit `IS NULL` branch to survive the filter.
const buildSourceScopeFilter = (
  scope: ConversationSourceScope,
  column: RawBuilder<unknown>,
): RawBuilder<unknown> => {
  const operatorTestChannels = sql.join(OPERATOR_TEST_SOURCE_CHANNELS.map((channel) => sql.val(channel)));
  const workbenchTestChannels = sql.join(WORKBENCH_TEST_SOURCE_CHANNELS.map((channel) => sql.val(channel)));
  switch (scope) {
    case "operator_test":
      return sql`AND ${column} IN (${workbenchTestChannels})`;
    case "all":
      return sql``;
    case "end_user":
    default:
      return sql`AND (${column} IS NULL OR ${column} NOT IN (${operatorTestChannels}))`;
  }
};

export type HistoryItemsSourceRecord =
  | {
      kind: "chat";
      id: string;
      sortAt: Date;
      conversation: ConversationRecord;
    }
  | {
      kind: "search";
      id: string;
      sortAt: Date;
      event: AuditEventRecord;
    };

export interface HistoryItemsRepositoryPort {
  listPageByWorkspaceId(
    workspaceId: string,
    input: {
      limit: number;
      offset?: number;
      sourceScope?: ConversationSourceScope;
      /** Case-insensitive substring over the conversation's title or first user message (issue #1126). */
      q?: string;
      agentId?: string;
      sourceOrigin?: string;
      outcome?: ConversationOutcomeFilter;
    },
  ): Promise<{ items: HistoryItemsSourceRecord[]; total: number; hasMore: boolean }>;
}

interface HistoryItemsRow {
  total_count: string;
  kind: "chat" | "search" | null;
  item_id: string | null;
  sort_at: Date | null;
  conversation_id: string | null;
  conversation_workspace_id: string | null;
  conversation_agent_id: string | null;
  conversation_agent_name: string | null;
  conversation_agent_internal_name: string | null;
  source_channel: string | null;
  source_origin: string | null;
  channel_context: ConversationChannelContext | null;
  anonymous_session_id: string | null;
  verified_customer_id: string | null;
  entry_page_url: string | null;
  title: string | null;
  conversation_created_at: Date | null;
  conversation_updated_at: Date | null;
  audit_id: string | null;
  audit_account_id: string | null;
  audit_workspace_id: string | null;
  event_type: string | null;
  event_status: string | null;
  metadata_json: Record<string, unknown> | null;
  audit_created_at: Date | null;
}

export class HistoryItemsRepository implements HistoryItemsRepositoryPort {
  constructor(private readonly db: Db) {}

  async listPageByWorkspaceId(
    workspaceId: string,
    input: {
      limit: number;
      offset?: number;
      sourceScope?: ConversationSourceScope;
      q?: string;
      agentId?: string;
      sourceOrigin?: string;
      outcome?: ConversationOutcomeFilter;
    },
  ): Promise<{ items: HistoryItemsSourceRecord[]; total: number; hasMore: boolean }> {
    const offset = input.offset ?? 0;
    const sourceLimit = offset + input.limit;
    const scope: ConversationSourceScope = input.sourceScope ?? "end_user";
    // Same filter applied to the row-producing CTE (aliased `c`) and the COUNT subquery
    // (unaliased `conversations`) so page rows and `total` stay consistent.
    const rowScopeFilter = buildSourceScopeFilter(scope, sql`c.source_channel`);
    const countScopeFilter = buildSourceScopeFilter(scope, sql`conversations.source_channel`);
    const rowTextSearchFilter = buildTextSearchFilter(input.q, sql`c.id`, sql`c.workspace_id`, sql`c.title`);
    const countTextSearchFilter = buildTextSearchFilter(input.q, sql`conversations.id`, sql`conversations.workspace_id`, sql`conversations.title`);
    const rowAgentFilter = buildAgentFilter(input.agentId, sql`c.agent_id`);
    const countAgentFilter = buildAgentFilter(input.agentId, sql`conversations.agent_id`);
    const rowSourceOriginFilter = buildSourceOriginFilter(input.sourceOrigin, sql`c.source_origin`);
    const countSourceOriginFilter = buildSourceOriginFilter(input.sourceOrigin, sql`conversations.source_origin`);
    const rowOutcomeFilter = buildOutcomeFilter(input.outcome, sql`c.id`, sql`c.workspace_id`, sql`c.updated_at`);
    const countOutcomeFilter = buildOutcomeFilter(input.outcome, sql`conversations.id`, sql`conversations.workspace_id`, sql`conversations.updated_at`);
    // q/agentId/sourceOrigin/outcome only mean something for a chat row — a search row has
    // none of those facets — so any one of them active excludes search rows entirely, the
    // same narrowing the All-lens toolbar already applied client-side for outcome/agent/site.
    const hasChatOnlyFilter = Boolean(input.q || input.agentId || input.sourceOrigin || input.outcome);
    const searchSourceFilter = hasChatOnlyFilter ? sql`AND FALSE` : sql``;
    // A multi-CTE UNION ALL analytical query: expressed with the Kysely `sql` tag (which
    // parameterizes the interpolated values) rather than the builder, which cannot model the
    // NULL-padded union of two heterogeneous sources without more noise than the SQL itself.
    const result = await sql<HistoryItemsRow>`
       WITH conversation_source AS (
         SELECT
           'chat'::text AS kind,
           c.id::text AS item_id,
           c.updated_at AS sort_at,
           c.created_at AS secondary_sort_at,
           c.id::text AS stable_id,
           c.id AS conversation_id,
           c.workspace_id AS conversation_workspace_id,
           c.agent_id AS conversation_agent_id,
           ag.name AS conversation_agent_name,
           ag.internal_name AS conversation_agent_internal_name,
           c.source_channel,
           c.source_origin,
           c.channel_context,
           c.anonymous_session_id,
           c.verified_customer_id,
           c.entry_page_url,
           c.title,
           c.created_at AS conversation_created_at,
           c.updated_at AS conversation_updated_at,
           NULL::uuid AS audit_id,
           NULL::uuid AS audit_account_id,
           NULL::uuid AS audit_workspace_id,
           NULL::text AS event_type,
           NULL::text AS event_status,
           NULL::jsonb AS metadata_json,
           NULL::timestamptz AS audit_created_at
         FROM conversations c
         LEFT JOIN agents ag ON ag.id = c.agent_id AND ag.workspace_id = c.workspace_id
         WHERE c.workspace_id = ${workspaceId}
           ${rowScopeFilter}
           ${rowTextSearchFilter}
           ${rowAgentFilter}
           ${rowSourceOriginFilter}
           ${rowOutcomeFilter}
         ORDER BY c.updated_at DESC, c.created_at DESC, c.id DESC
         LIMIT ${sourceLimit}
       ),
       search_source AS (
         SELECT
           'search'::text AS kind,
           COALESCE(NULLIF(a.metadata_json ->> 'searchId', ''), a.id::text) AS item_id,
           a.created_at AS sort_at,
           a.created_at AS secondary_sort_at,
           a.id::text AS stable_id,
           NULL::uuid AS conversation_id,
           NULL::uuid AS conversation_workspace_id,
           NULL::uuid AS conversation_agent_id,
           NULL::text AS conversation_agent_name,
           NULL::text AS conversation_agent_internal_name,
           NULL::text AS source_channel,
           NULL::text AS source_origin,
           NULL::jsonb AS channel_context,
           NULL::text AS anonymous_session_id,
           NULL::text AS verified_customer_id,
           NULL::text AS entry_page_url,
           NULL::text AS title,
           NULL::timestamptz AS conversation_created_at,
           NULL::timestamptz AS conversation_updated_at,
           a.id AS audit_id,
           a.account_id AS audit_account_id,
           a.workspace_id AS audit_workspace_id,
           a.event_type,
           a.event_status,
           a.metadata_json,
           a.created_at AS audit_created_at
         FROM audit_events a
         WHERE a.workspace_id = ${workspaceId}
           AND a.event_type = 'document.search'
           ${searchSourceFilter}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT ${sourceLimit}
       ),
       history_items AS (
         SELECT * FROM conversation_source
         UNION ALL
         SELECT * FROM search_source
       ),
       counted AS (
         SELECT (
           (SELECT COUNT(*) FROM conversations WHERE workspace_id = ${workspaceId} ${countScopeFilter}
              ${countTextSearchFilter}
              ${countAgentFilter}
              ${countSourceOriginFilter}
              ${countOutcomeFilter}
           ) +
           (SELECT COUNT(*) FROM audit_events WHERE workspace_id = ${workspaceId} AND event_type = 'document.search'
              ${searchSourceFilter}
           )
         )::text AS total_count
       ),
       paged AS (
         SELECT *
         FROM history_items
         ORDER BY sort_at DESC, secondary_sort_at DESC, stable_id DESC
         LIMIT ${input.limit}
         OFFSET ${offset}
       )
       SELECT counted.total_count, paged.*
       FROM counted
       LEFT JOIN paged ON TRUE`.execute(this.db);
    const rows = result.rows;

    const total = Number(rows[0]?.total_count ?? "0");
    const items = rows.flatMap((row): HistoryItemsSourceRecord[] => {
      if (row.kind === "chat" && row.item_id && row.sort_at && row.conversation_id && row.conversation_workspace_id && row.conversation_created_at && row.conversation_updated_at) {
        return [{
          kind: "chat",
          id: row.item_id,
          sortAt: new Date(row.sort_at),
          conversation: {
            id: row.conversation_id,
            workspaceId: row.conversation_workspace_id,
            agentId: row.conversation_agent_id ?? null,
            agentName: row.conversation_agent_name ?? null,
            agentInternalName: normalizeNullableText(row.conversation_agent_internal_name),
            sourceChannel: row.source_channel,
            sourceOrigin: row.source_origin,
            channelContext: (row.channel_context) ?? null,
            anonymousSessionId: row.anonymous_session_id,
            verifiedCustomerId: row.verified_customer_id,
            entryPageUrl: row.entry_page_url,
            title: row.title,
            createdAt: new Date(row.conversation_created_at),
            updatedAt: new Date(row.conversation_updated_at),
          },
        }];
      }

      if (row.kind === "search" && row.item_id && row.sort_at && row.audit_id && row.event_type && row.event_status && row.audit_created_at) {
        return [{
          kind: "search",
          id: row.item_id,
          sortAt: new Date(row.sort_at),
          event: {
            id: row.audit_id,
            accountId: row.audit_account_id,
            workspaceId: row.audit_workspace_id,
            eventType: row.event_type,
            eventStatus: row.event_status,
            metadata: row.metadata_json ?? {},
            createdAt: new Date(row.audit_created_at),
          },
        }];
      }

      return [];
    });

    return {
      items,
      total,
      hasMore: offset + items.length < total,
    };
  }
}
