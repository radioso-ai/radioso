import { teammateLabel } from "../../modules/auth/contracts/index.js";
import type { TeammateLabelReaderPort } from "../../modules/chat/contracts/index.js";

interface TeammateProfileReader {
  findByIds(ids: readonly string[]): Promise<ReadonlyArray<{ id: string; email: string; displayName: string | null }>>;
}

/**
 * Answers chat history's "who is this teammate" for operator reads: one read of the users' profiles
 * as they are now, each named by the auth module's teammate label (display name, else email). A user
 * who no longer exists is left out, so the caller falls back to what it stored.
 */
export const createTeammateLabelReader = (deps: {
  readonly users: TeammateProfileReader;
}): TeammateLabelReaderPort => ({
  labelsByUserIds: async (userIds) => {
    if (userIds.length === 0) {
      return new Map();
    }
    const users = await deps.users.findByIds(userIds);
    return new Map(users.map((user) => [user.id, teammateLabel(user)]));
  },
});
