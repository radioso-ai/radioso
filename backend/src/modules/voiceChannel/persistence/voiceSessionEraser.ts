import type {
  ConversationDataEraser,
  ConversationErasureScope,
  VisitorKeyDataEraser,
  VisitorKeyErasureScope,
} from "../../../shared/domain/conversationDataErasure.js";
import { anyOf } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";

/**
 * Erases the voice sessions of erased conversations, and the calls the website embed started for an
 * erased visitor whose first turn never came: the session key, the visitor's key and public session
 * that started the call, and where the call's recording is. The conversation link is SET NULL, so a
 * conversation deleted any other way leaves the row, and with it the way to the recording; an
 * erasure reads the recordings through `VendorHeldConversationDataEraser` before this runs, and asks
 * the vendor to delete them once it committed. A workspace's rows cascade with it; the workspace
 * scope removes them too, after the same read.
 */
export class VoiceSessionEraser implements ConversationDataEraser, VisitorKeyDataEraser {
  readonly owner = "voice-channel";

  constructor(private readonly db: Db) {}

  async erase(scope: ConversationErasureScope): Promise<number> {
    if (scope.kind === "conversations" && scope.conversationIds.length === 0) {
      return 0;
    }
    const deleted = await this.db
      .deleteFrom("voice_sessions")
      .where("workspace_id", "=", scope.workspaceId)
      .$if(scope.kind === "conversations", (qb) =>
        qb.where((eb) => anyOf(eb.ref("conversation_id"), scope.kind === "conversations" ? scope.conversationIds : [], "uuid[]")))
      .executeTakeFirst();
    return Number(deleted.numDeletedRows);
  }

  async eraseVisitorKey(scope: VisitorKeyErasureScope): Promise<number> {
    const deleted = await this.db
      .deleteFrom("voice_sessions")
      .where("workspace_id", "=", scope.workspaceId)
      .where("started_visitor_key", "=", scope.visitorKey)
      .executeTakeFirst();
    return Number(deleted.numDeletedRows);
  }
}
