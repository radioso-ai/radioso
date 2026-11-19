import { describe, expectTypeOf, it } from "vitest";

import type { PolicyChangeHandoffReason } from "../../../src/modules/emailChannel/mailboxes/mailboxPolicyChangeUnitOfWork.js";
import type { ChatTurnHandoffReason } from "../../../src/modules/chat/types/chatResponses.js";
import type { ConversationOwnershipReasonCode } from "../../../src/shared/domain/conversationOwnershipReasons.js";

describe("handoff reason codes", () => {
  it("lists every reason a chat turn or a mailbox policy change hands off with, so each handoff reaches the event log", () => {
    expectTypeOf<ChatTurnHandoffReason>().toExtend<ConversationOwnershipReasonCode>();
    expectTypeOf<PolicyChangeHandoffReason>().toExtend<ConversationOwnershipReasonCode>();
  });
});
