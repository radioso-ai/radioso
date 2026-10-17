import type { ConversationDataEraser, ConversationErasureScope } from "../../../shared/domain/conversationDataErasure.js";
import { anyOf } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";

/**
 * Erases the voice sessions of erased conversations: the session key, the website visitor who
 * started the call, and where the call's recording is. Its conversation link is SET NULL, so a
 * conversation deleted any other way leaves the row, and with it the way to the recording; an
 * erasure reads the recordings through `VendorHeldConversationDataEraser` before this runs, and
 * asks the vendor to delete them once it committed. A workspace's rows cascade with it; the
 * workspace scope removes them too, after the same read.
 */
export class VoiceSessionEraser implements ConversationDataEraser {
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
}
