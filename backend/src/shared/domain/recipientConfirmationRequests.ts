import { randomUUID } from "node:crypto";

import { normalizeRecipientEmails } from "./recipientEmailAudit.js";

/** Asks addresses newly added to a notification recipient list to confirm before a notice is due. */
export interface RecipientConfirmationRequester {
  requestConfirmations(input: {
    workspaceId: string;
    agentId: string;
    emails: readonly string[];
    idempotencyKey: string;
  }): Promise<void>;
}

export const requestAddedRecipientConfirmations = async (
  requester: RecipientConfirmationRequester | undefined,
  input: { workspaceId: string; agentId: string; previous: readonly string[]; next: readonly string[] },
): Promise<void> => {
  if (!requester) return;
  const previous = new Set(normalizeRecipientEmails(input.previous));
  const added = normalizeRecipientEmails(input.next).filter((email) => !previous.has(email));
  if (added.length === 0) return;
  await requester.requestConfirmations({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    emails: added,
    idempotencyKey: randomUUID(),
  });
};
