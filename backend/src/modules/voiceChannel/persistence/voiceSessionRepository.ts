import type { Db } from "../../../shared/infra/kysely/types.js";
import type { VoiceSessionRef } from "../domain.js";

export class VoiceSessionRepository {
  constructor(private readonly db: Db) {}

  async findConversationId(session: VoiceSessionRef): Promise<string | null> {
    const row = await this.db
      .selectFrom("voice_sessions")
      .select("conversation_id")
      .where("workspace_id", "=", session.workspaceId)
      .where("agent_id", "=", session.agentId)
      .where("vendor", "=", session.vendor)
      .where("session_key", "=", session.sessionKey)
      .executeTakeFirst();
    return row?.conversation_id ?? null;
  }

  /** The first binding wins: a concurrent first turn of the same session reads it back. */
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
      .onConflict((oc) => oc.columns(["agent_id", "vendor", "session_key"]).doNothing())
      .execute();
    const bound = await this.findConversationId(session);
    if (!bound) {
      throw new Error("Voice session binding is missing after insert");
    }
    return bound;
  }
}
