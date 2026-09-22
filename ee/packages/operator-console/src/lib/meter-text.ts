import type { OrganizationDirectoryRow } from "./staff-auth-api";

export function limitText(limit: number | null): string {
  return limit === null ? "unlimited" : limit.toLocaleString();
}

type DirectoryMeters = Pick<OrganizationDirectoryRow, "monthlyAnswers" | "monthlyConversations">;

/**
 * The headline monthly meter for a directory row. Catalog tiers meter conversations
 * and leave the answer limit null, so reading the answer meter alone would print
 * "unlimited" for a capped tier.
 */
export const directoryMeterText = (row: DirectoryMeters): string => {
  if (row.monthlyConversations) {
    return `${row.monthlyConversations.used.toLocaleString()} / ${limitText(row.monthlyConversations.limit)} conv`;
  }
  return `${row.monthlyAnswers.used.toLocaleString()} / ${limitText(row.monthlyAnswers.limit)}`;
};
