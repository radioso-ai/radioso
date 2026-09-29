import { teammateLabel } from "../../modules/auth/contracts/index.js";
import type { AccountMembershipUserRecord } from "../../db/repositories/accountMembershipRepository.js";
import type { AccountAccessService } from "../../modules/account/services/accountAccessService.js";
import type {
  ConversationOperator,
  ConversationOperatorDirectory,
} from "../../modules/handoff/public.js";

/**
 * Answers handoff's "who can own a conversation here" from the organisation's active members,
 * keeping those whose user is not disabled and who hold `workspace.conversation.takeover` on the
 * workspace. Eligibility goes through `AccountAccessService.hasPermission`, the same role and
 * grant resolution the routes enforce, so no role rule is restated here.
 */
export const createConversationOperatorDirectory = (deps: {
  readonly accountAccess: Pick<AccountAccessService, "listAccountUsers" | "findAccountUser" | "hasPermission">;
}): ConversationOperatorDirectory => {
  const asOperator = async (
    member: AccountMembershipUserRecord,
    scope: { accountId: string; workspaceId: string },
  ): Promise<ConversationOperator | null> => {
    if (member.disabledAt !== null) {
      return null;
    }
    const permitted = await deps.accountAccess.hasPermission({
      accountId: scope.accountId,
      userId: member.userId,
      workspaceId: scope.workspaceId,
      permission: "workspace.conversation.takeover",
    });
    return permitted ? { userId: member.userId, label: teammateLabel(member) } : null;
  };

  return {
    list: async (input) => {
      const members = await deps.accountAccess.listAccountUsers(input.accountId);
      const operators = await Promise.all(members.map((member) => asOperator(member, input)));
      return operators.filter((operator): operator is ConversationOperator => operator !== null);
    },
    find: async (input) => {
      const member = await deps.accountAccess.findAccountUser(input.accountId, input.userId);
      return member ? asOperator(member, input) : null;
    },
  };
};
