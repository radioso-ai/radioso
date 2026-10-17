import { isVoiceVendor, isVoiceVendorRegion } from "../../../shared/domain/voiceVendor.js";
import { currentTimestamp } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type {
  VoiceRecordingLocation,
  VoiceRecordingRef,
  VoiceRecordingScope,
  VoiceRecordingStore,
  VoiceRecordingToErase,
  VoiceReportableSession,
  VoiceSessionRef,
  VoiceSessionStartLookup,
  VoiceSessionStartRegistry,
  VoiceSessionVendorAgent,
  VoiceSessionVisitor,
  VoiceVendorConversationReport,
} from "../domain.js";

/** Postgres' unique violation: the vendor conversation id is already another session's. */
const UNIQUE_VIOLATION = "23505";

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;

interface RecordingRow {
  vendor: string;
  vendor_region: string | null;
  vendor_conversation_id: string | null;
}

/** A row that names a recording a vendor adapter can reach; anything else names none. */
const locationOf = (row: RecordingRow): VoiceRecordingLocation | null =>
  row.vendor_conversation_id && isVoiceVendor(row.vendor) && row.vendor_region && isVoiceVendorRegion(row.vendor_region)
    ? { vendor: row.vendor, region: row.vendor_region, vendorConversationId: row.vendor_conversation_id }
    : null;

/**
 * `voice_sessions`: one row per session, scoped to its workspace, agent and vendor. A session
 * Radioso started holds the visitor who asked for it until its first turn binds the conversation,
 * the vendor agent it opened on and its account's region, and, once its page reports it and the
 * vendor confirms it, the vendor's id for the call. A row that holds that id is the only record of
 * where the recording is, so nothing here deletes it: it goes with its conversation or workspace,
 * and outlives its agent.
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
  /**
   * Records a started session, and clears out the agent's starts whose first turn never came, and
   * the workspace's from agents since deleted. A start whose page reported a recording stays.
   */
  async register(start: { session: VoiceSessionRef; visitor: VoiceSessionVisitor; expiresAt: Date; vendorAgent: VoiceSessionVendorAgent }): Promise<void> {
    const { session, visitor } = start;
    await this.db
      .deleteFrom("voice_sessions")
      .where("workspace_id", "=", session.workspaceId)
      .where((eb) => eb.or([eb("agent_id", "=", session.agentId), eb("agent_id", "is", null)]))
      .where("conversation_id", "is", null)
      .where("vendor_conversation_id", "is", null)
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
        vendor_agent_id: start.vendorAgent.agentId,
        vendor_region: start.vendorAgent.region,
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

  async findReportableSession(report: Omit<VoiceVendorConversationReport, "vendorConversationId">): Promise<VoiceReportableSession | null> {
    const row = await this.db
      .selectFrom("voice_sessions")
      .select(["vendor", "vendor_agent_id", "vendor_region"])
      .where("workspace_id", "=", report.workspaceId)
      .where("agent_id", "=", report.agentId)
      .where("session_key", "=", report.sessionKey)
      .where("started_public_session_id", "=", report.publicSessionId)
      .where("start_expires_at", ">", currentTimestamp())
      .where("vendor_conversation_id", "is", null)
      .executeTakeFirst();
    if (!row?.vendor_agent_id || !row.vendor_region || !isVoiceVendor(row.vendor) || !isVoiceVendorRegion(row.vendor_region)) return null;
    return { vendor: row.vendor, vendorAgent: { agentId: row.vendor_agent_id, region: row.vendor_region } };
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
        .where("vendor_agent_id", "is not", null)
        .where("vendor_region", "is not", null)
        .where("vendor_conversation_id", "is", null)
        .executeTakeFirst();
      return Number(updated.numUpdatedRows) > 0;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /** Only for a conversation that still exists and belongs to the workspace, whatever the session row says. */
  async findRecording(input: { workspaceId: string; conversationId: string }): Promise<VoiceRecordingRef | null> {
    const row = await this.db
      .selectFrom("voice_sessions")
      .innerJoin("conversations", "conversations.id", "voice_sessions.conversation_id")
      .select(["voice_sessions.vendor", "voice_sessions.vendor_region", "voice_sessions.vendor_conversation_id"])
      .where("voice_sessions.workspace_id", "=", input.workspaceId)
      .where("conversations.workspace_id", "=", input.workspaceId)
      .where("voice_sessions.conversation_id", "=", input.conversationId)
      .where("voice_sessions.vendor_conversation_id", "is not", null)
      .orderBy("voice_sessions.created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    const location = row ? locationOf(row) : null;
    return location ? { ...location, conversationId: input.conversationId } : null;
  }

  async listRecordings(scope: VoiceRecordingScope): Promise<VoiceRecordingToErase[]> {
    if (scope.kind === "conversations" && scope.conversationIds.length === 0) return [];
    let query = this.db
      .selectFrom("voice_sessions")
      .select(["conversation_id", "vendor", "vendor_region", "vendor_conversation_id"])
      .where("workspace_id", "=", scope.workspaceId)
      .where("vendor_conversation_id", "is not", null);
    if (scope.kind === "conversations") query = query.where("conversation_id", "in", [...scope.conversationIds]);
    const rows = await query.orderBy("created_at", "asc").execute();
    return rows.flatMap((row) => {
      const location = locationOf(row);
      return location ? [{ ...location, workspaceId: scope.workspaceId, conversationId: row.conversation_id }] : [];
    });
  }
}
