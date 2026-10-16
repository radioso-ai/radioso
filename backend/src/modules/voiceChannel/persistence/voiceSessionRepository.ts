import { currentTimestamp } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import type {
  VoiceSessionRef,
  VoiceSessionStartLookup,
  VoiceSessionStartRegistry,
  VoiceSessionVisitor,
} from "../domain.js";

/**
 * `voice_sessions`: one row per session, scoped to its workspace, agent and vendor. A session
 * Radioso started holds the visitor who asked for it until its first turn binds the conversation.
 */
export class VoiceSessionRepository implements VoiceSessionStartRegistry, VoiceSessionStartLookup {
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
  async register(start: { session: VoiceSessionRef; visitor: VoiceSessionVisitor; expiresAt: Date }): Promise<void> {
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
}
