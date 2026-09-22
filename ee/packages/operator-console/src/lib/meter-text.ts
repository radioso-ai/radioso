import type { OrganizationDirectoryRow } from "./staff-auth-api";

/** Pinned so a server render and a browser render of the same meter agree, and so a
 *  fractional conversation count keeps its decimal point on a non-English host. */
const meterNumber = new Intl.NumberFormat("en-US");

export function limitText(limit: number | null): string {
  return limit === null ? "unlimited" : meterNumber.format(limit);
}

type DirectoryMeters = Pick<OrganizationDirectoryRow, "monthlyAnswers" | "monthlyConversations">;

/**
 * The headline monthly meter for a directory row. Catalog tiers meter conversations
 * and leave the answer limit null, so reading the answer meter alone would print
 * "unlimited" for a capped tier.
 */
export const directoryMeterText = (row: DirectoryMeters): string => {
  if (row.monthlyConversations) {
    return `${meterNumber.format(row.monthlyConversations.used)} / ${limitText(row.monthlyConversations.limit)} conv`;
  }
  return `${meterNumber.format(row.monthlyAnswers.used)} / ${limitText(row.monthlyAnswers.limit)}`;
};
