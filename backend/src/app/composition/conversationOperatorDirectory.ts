import { teammateLabel } from "../../modules/auth/contracts/index.js";
import type { AccountMembershipUserRecord } from "../../db/repositories/accountMembershipRepository.js";
import type { AccountAccessService } from "../../modules/account/services/accountAccessService.js";
import type {
  ConversationOperator,
  ConversationOperatorDirectory,
} from "../../modules/handoff/public.js";

const TAKEOVER_PERMISSION = "workspace.conversation.takeover";

const asOperator = (member: AccountMembershipUserRecord): ConversationOperator => ({
  userId: member.userId,
  label: teammateLabel(member),
});

/**
 * Answers handoff's "who can own a conversation here" from the organisation's active members,
 * keeping those whose user is not disabled and who hold `workspace.conversation.takeover` on the
 * workspace. Eligibility is the account module's: the list in one bulk read, one teammate through
 * `hasPermission`, both on the same role and grant rules the routes enforce, so none is restated.
 */
export const createConversationOperatorDirectory = (deps: {
  readonly accountAccess: Pick<AccountAccessService, "listMembersWithWorkspacePermission" | "findAccountUser" | "hasPermission">;
}): ConversationOperatorDirectory => ({
  list: async (input) => {
    const members = await deps.accountAccess.listMembersWithWorkspacePermission({ ...input, permission: TAKEOVER_PERMISSION });
    return members.map(asOperator);
  },
  find: async (input) => {
    const member = await deps.accountAccess.findAccountUser(input.accountId, input.userId);
    if (!member || member.disabledAt !== null) {
      return null;
    }
    const permitted = await deps.accountAccess.hasPermission({ ...input, permission: TAKEOVER_PERMISSION });
    return permitted ? asOperator(member) : null;
  },
});
