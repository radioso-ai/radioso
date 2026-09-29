import { teammateLabel, visitorFacingName } from "../auth/contracts/index.js";
import { notFound } from "../../shared/domain/errors.js";

/**
 * Who a human operator is, in the two places a person shows up. The teammate label names them
 * to other teammates (Inbox "taken by", filters, Ray, Slack). The reply signature names them to
 * the visitor on a reply they send, so it never falls back to an email — an email is private to
 * the workspace. A null signature leaves the reply unsigned; the visitor surface names it as a
 * teammate.
 */
export interface OperatorIdentity {
  userId: string;
  teammateLabel: string;
  replySignature: string | null;
}

interface OperatorIdentityUserReader {
  findById(userId: string): Promise<{ email: string; displayName: string | null } | null>;
}

interface OperatorIdentityOrganizationReader {
  findById(accountId: string): Promise<{ name: string | null } | null>;
}

/** Resolves a signed-in teammate into their {@link OperatorIdentity}, fresh on every call. */
export class OperatorIdentityResolver {
  constructor(private readonly dependencies: {
    users: OperatorIdentityUserReader;
    accounts: OperatorIdentityOrganizationReader;
  }) {}

  async resolve(input: { accountId: string; userId: string }): Promise<OperatorIdentity> {
    const [user, organization] = await Promise.all([
      this.dependencies.users.findById(input.userId),
      this.dependencies.accounts.findById(input.accountId),
    ]);
    if (!user) {
      throw notFound("Operator not found");
    }

    return {
      userId: input.userId,
      teammateLabel: teammateLabel(user),
      replySignature: visitorFacingName({
        displayName: user.displayName,
        organizationName: organization?.name ?? null,
      }),
    };
  }
}
