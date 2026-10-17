import { isVoiceVendor, isVoiceVendorRegion, type VoiceVendorRegion } from "../../../shared/domain/voiceVendor.js";
import { currentTimestamp } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type {
  VoiceRecordingRef,
  VoiceRecordingScope,
  VoiceRecordingStore,
  VoiceSessionRef,
  VoiceSessionStartLookup,
  VoiceSessionStartRegistry,
  VoiceSessionVisitor,
  VoiceVendorConversationReport,
} from "../domain.js";

/** Postgres' unique violation: the vendor conversation id is already another session's. */
const UNIQUE_VIOLATION = "23505";

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;

interface RecordingRow {
  conversation_id: string | null;
  vendor: string;
  vendor_region: string | null;
  vendor_conversation_id: string | null;
}

/** A row that names a recording a vendor adapter can reach; anything else names none. */
const recordingOf = (row: RecordingRow): VoiceRecordingRef | null =>
  row.conversation_id && row.vendor_conversation_id && isVoiceVendor(row.vendor) && row.vendor_region && isVoiceVendorRegion(row.vendor_region)
    ? { conversationId: row.conversation_id, vendor: row.vendor, region: row.vendor_region, vendorConversationId: row.vendor_conversation_id }
    : null;

/**
 * `voice_sessions`: one row per session, scoped to its workspace, agent and vendor. A session
 * Radioso started holds the visitor who asked for it until its first turn binds the conversation,
 * the vendor account's region, and, once its page reports it, the vendor's id for the call.
 */
export class VoiceSessionRepository implements VoiceSessionStartRegistry, VoiceSessionStartLookup, VoiceRecordingStore {
  constructor(private readonly db: Db) {}

  private matching(session: VoiceSessionRef) {
    return this.db
      .selectFrom("voice_sessions")
      .where("workspace_id", "=", session.workspaceId)
      .where("agent_id", "=", session.agentId)
      .where("vendor", "=", session.vendor)
      .where("session_key", "=", session.sessionKey);
  }

  async findConversationId(session: VoiceSessionRef): Promise<string | null> {
    const row = await this.matching(session).select("conversation_id").executeTakeFirst();
    return row?.conversation_id ?? null;
  }

  /**
   * The first binding wins: a concurrent first turn of the same session reads it back. A started
   * session's row has no conversation yet, and the first turn fills it in.
   */
  async bind(session: VoiceSessionRef, conversationId: string): Promise<string> {
    await this.db
      .insertInto("voice_sessions")
      .values({
        workspace_id: session.workspaceId,
        agent_id: session.agentId,
        vendor: session.vendor,
        session_key: session.sessionKey,
        conversation_id: conversationId,
      })
      .onConflict((oc) =>
        oc.columns(["agent_id", "vendor", "session_key"])
          .doUpdateSet((eb) => ({ conversation_id: eb.ref("excluded.conversation_id") }))
          .where("voice_sessions.conversation_id", "is", null)
          .where("voice_sessions.workspace_id", "=", session.workspaceId),
      )
      .execute();
    const bound = await this.findConversationId(session);
    if (!bound) {
      throw new Error("Voice session binding is missing after insert");
    }
    return bound;
  }

  /** Records a started session, and clears out the agent's starts whose first turn never came. */
  async register(start: { session: VoiceSessionRef; visitor: VoiceSessionVisitor; expiresAt: Date; region: VoiceVendorRegion }): Promise<void> {
    const { session, visitor } = start;
    await this.db
      .deleteFrom("voice_sessions")
      .where("agent_id", "=", session.agentId)
      .where("conversation_id", "is", null)
      .where("start_expires_at", "<", currentTimestamp())
      .execute();
    await this.db
      .insertInto("voice_sessions")
      .values({
        workspace_id: session.workspaceId,
        agent_id: session.agentId,
        vendor: session.vendor,
        session_key: session.sessionKey,
        conversation_id: null,
        started_public_session_id: visitor.publicSessionId,
        started_visitor_key: visitor.visitorKey,
        start_expires_at: start.expiresAt,
        vendor_region: start.region,
      })

      .onConflict((oc) => oc.columns(["agent_id", "vendor", "session_key"]).doNothing())
      .execute();
  }

  async findStartedVisitor(session: VoiceSessionRef): Promise<VoiceSessionVisitor | null> {
    const row = await this.matching(session)
      .select(["started_public_session_id", "started_visitor_key"])
      .where("conversation_id", "is", null)
      .where("start_expires_at", ">", currentTimestamp())
      .executeTakeFirst();
    if (!row?.started_public_session_id) return null;
    return { publicSessionId: row.started_public_session_id, visitorKey: row.started_visitor_key };
  }

  async recordVendorConversation(report: VoiceVendorConversationReport): Promise<boolean> {
    try {
      const updated = await this.db
        .updateTable("voice_sessions")
        .set({ vendor_conversation_id: report.vendorConversationId })
        .where("workspace_id", "=", report.workspaceId)
        .where("agent_id", "=", report.agentId)
        .where("session_key", "=", report.sessionKey)
        .where("started_public_session_id", "=", report.publicSessionId)
        .where("start_expires_at", ">", currentTimestamp())
        .where("vendor_region", "is not", null)
        .where("vendor_conversation_id", "is", null)
        .executeTakeFirst();
      return Number(updated.numUpdatedRows) > 0;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async findRecording(input: { workspaceId: string; conversationId: string }): Promise<VoiceRecordingRef | null> {
    const row = await this.db
      .selectFrom("voice_sessions")
      .select(["conversation_id", "vendor", "vendor_region", "vendor_conversation_id"])
      .where("workspace_id", "=", input.workspaceId)
      .where("conversation_id", "=", input.conversationId)
      .where("vendor_conversation_id", "is not", null)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? recordingOf(row) : null;
  }

  async listRecordings(scope: VoiceRecordingScope): Promise<VoiceRecordingRef[]> {
    if (scope.kind === "conversations" && scope.conversationIds.length === 0) return [];
    let query = this.db
      .selectFrom("voice_sessions")
      .select(["conversation_id", "vendor", "vendor_region", "vendor_conversation_id"])
      .where("workspace_id", "=", scope.workspaceId)
      .where("vendor_conversation_id", "is not", null)
      .where("conversation_id", "is not", null);
    if (scope.kind === "conversations") query = query.where("conversation_id", "in", [...scope.conversationIds]);
    const rows = await query.orderBy("created_at", "asc").execute();
    return rows.flatMap((row) => recordingOf(row) ?? []);
  }
}
