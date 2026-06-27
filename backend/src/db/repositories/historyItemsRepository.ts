import { sql } from "kysely";

import type { AuditEventRecord } from "./auditEventRepository.js";
import type { ConversationRecord } from "./conversationRepository.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { ConversationChannelContext } from "@radioso/conversation-contract";

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
    input: { limit: number; offset?: number },
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
  source_channel: string | null;
  source_origin: string | null;
  channel_context: ConversationChannelContext | null;
  anonymous_session_id: string | null;
  verified_customer_id: string | null;
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
    input: { limit: number; offset?: number },
  ): Promise<{ items: HistoryItemsSourceRecord[]; total: number; hasMore: boolean }> {
    const offset = input.offset ?? 0;
    const sourceLimit = offset + input.limit;
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
           c.source_channel,
           c.source_origin,
           c.channel_context,
           c.anonymous_session_id,
           c.verified_customer_id,
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
           NULL::text AS source_channel,
           NULL::text AS source_origin,
           NULL::jsonb AS channel_context,
           NULL::text AS anonymous_session_id,
           NULL::text AS verified_customer_id,
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
           (SELECT COUNT(*) FROM conversations WHERE workspace_id = ${workspaceId}) +
           (SELECT COUNT(*) FROM audit_events WHERE workspace_id = ${workspaceId} AND event_type = 'document.search')
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
            sourceChannel: row.source_channel,
            sourceOrigin: row.source_origin,
            channelContext: (row.channel_context as ConversationChannelContext | null) ?? null,
            anonymousSessionId: row.anonymous_session_id,
            verifiedCustomerId: row.verified_customer_id,
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
