import type { ContactHistoryDetail } from "../radiosoModuleTypes.js";
import type { HumanContactHistoryRow } from "./humanContactTypes.js";
import {
  mapContactHistoryDetail,
  mapContactHistorySummary,
  queryRows,
} from "./humanContactTypes.js";
import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";

export class HumanContactHistoryService {
  constructor(private readonly database: UsageLimitDatabasePort) {}

  async listPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number } = { limit: 50, offset: 0 },
  ) {
    const offset = input.offset ?? 0;
    const rows = await queryRows<HumanContactHistoryRow>(
      this.database,
      `SELECT
         COUNT(*) OVER()::text AS total_count,
         id::text,
         workspace_id::text,
         conversation_id::text,
         assistant_message_id::text,
         source_channel,
         source_origin,
         user_email,
         message,
         trigger_source,
         trigger_reason,
         status,
         attempts,
         final_delivery_error,
         activity_trace,
         created_at,
         updated_at
       FROM ee_contact_requests
       WHERE workspace_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2
       OFFSET $3`,
      [workspaceId, input.limit, offset],
    );
    const total = Number(rows[0]?.total_count ?? "0");
    const contacts = rows.map(mapContactHistorySummary);

    return {
      contacts,
      total,
      nextCursor: null,
      hasMore: offset + contacts.length < total,
    };
  }

  async getById(workspaceId: string, requestId: string): Promise<ContactHistoryDetail | null> {
    const [row] = await queryRows<HumanContactHistoryRow>(
      this.database,
      `SELECT
         id::text,
         workspace_id::text,
         conversation_id::text,
         assistant_message_id::text,
         source_channel,
         source_origin,
         user_email,
         message,
         trigger_source,
         trigger_reason,
         status,
         attempts,
         final_delivery_error,
         activity_trace,
         created_at,
         updated_at
       FROM ee_contact_requests
       WHERE workspace_id = $1
         AND id = $2
       LIMIT 1`,
      [workspaceId, requestId],
    );

    return row ? mapContactHistoryDetail(row) : null;
  }
}
